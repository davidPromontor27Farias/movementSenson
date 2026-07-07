
(function () {
  'use strict';

  /* =====================================================================
   * CONFIGURACIÓN
   * ===================================================================== */
  const SAMPLE_INTERVAL_MS   = 50;   // cadencia de integración (regla 2)
  const LOCK_THRESHOLD_KMH   = 1;    // umbral de bloqueo
  const UNLOCK_THRESHOLD_KMH = 0.8;  // umbral de desbloqueo
  const LOCK_CONSECUTIVE     = 3;    // muestras seguidas para bloquear
  const UNLOCK_CONSECUTIVE   = 2;    // muestras seguidas para desbloquear
  const UI_REFRESH_MS        = 100;  // refresco visual (no crítico, ahorra batería)

  const GRAVITY_FILTER_ALPHA = 0.8;  // filtro paso-bajo para estimar gravedad cuando no hay 'acceleration' lineal
  const NOISE_DEADBAND_MS2 = 0.2;    // ruido/temblor de mano por eje; por debajo de esto se trata como 0
  const STILL_RESET_SAMPLES = 2;     // muestras seguidas "quietas" (100ms) para forzar velocidad a 0 (ZUPT simplificado)
  // La integración pura (v = v0 + a*dt) diverge con el tiempo porque el ruido
  // del sensor se acumula (deriva / "integration drift"). Para que el
  // prototipo sea utilizable se integra la aceleración CON SIGNO por eje
  // (no su magnitud, que siempre es >= 0 y por eso cualquier vibración de
  // la mano —oscilatoria por naturaleza— sumaría velocidad sin parar) y se
  // aplica amortiguación + un reset a cero cuando el sensor está en reposo.
  // Es una aproximación, NO un filtro de Kalman ni un ZUPT real.
  const VELOCITY_DECAY = 0.96;

  const ORIENTATION_FALLBACK_SCALE = 0.35; // escala empírica: grados/seg -> pseudo m/s^2

  /* =====================================================================
   * ESTADO
   * ===================================================================== */
  let velocityKmh = 0;
  let vx = 0, vy = 0, vz = 0;       // vector de velocidad en m/s (con signo, por eje)
  let stillCount = 0;               // muestras consecutivas con aceleración por debajo del deadband en los 3 ejes
  let aboveCount = 0;
  let belowCount = 0;
  let locked = false;

  let motionSupported = false;      // true en cuanto llega al menos un evento devicemotion útil
  let latestAccel = { x: 0, y: 0, z: 0, hasData: false, isLinear: false };
  let gravity = { x: 0, y: 0, z: 0, ready: false }; // estimación de gravedad (filtro paso-bajo) por eje

  let lastOrientationSample = null; // {beta, gamma, t}
  let orientationRate = 0;          // grados/seg, decae solo (ver integrateStep)

  let simulationMode = false;
  let simulatedVelocity = 0;

  let lastIntegrationTime = 0;
  let lastUIUpdateTime = 0;

  /* =====================================================================
   * DOM
   * ===================================================================== */
  const overlay        = document.getElementById('lockOverlay');
  const velReadout      = document.getElementById('velReadout');
  const stateReadout    = document.getElementById('stateReadout');
  const sourceReadout   = document.getElementById('sourceReadout');
  const countReadout    = document.getElementById('countReadout');
  const btnPermission   = document.getElementById('btnPermission');
  const sensorBadge     = document.getElementById('sensorBadge');
  const simToggle       = document.getElementById('simToggle');
  const simBadge        = document.getElementById('simBadge');
  const simSlider       = document.getElementById('simSlider');
  const simValue        = document.getElementById('simValue');
  const chartCtx        = document.getElementById('fillerChart').getContext('2d');
  const chartHistory     = new Array(80).fill(0);

  /* =====================================================================
   * BLOQUEO / DESBLOQUEO
   * requestAnimationFrame garantiza que el cambio de clase se aplique en
   * el siguiente frame de pintado (~16 ms a 60Hz), muy por debajo del
   * límite de 100 ms exigido en la regla 4.
   * ===================================================================== */
  function lock() {
    if (locked) return;
    locked = true;
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
    });
  }

  function unlock() {
    if (!locked) return;
    locked = false;
    requestAnimationFrame(() => {
      overlay.classList.remove('visible');
      overlay.setAttribute('aria-hidden', 'true');
    });
  }

  /* =====================================================================
   * MÁQUINA DE HISTÉRESIS
   * Entre 0.8 y 1 km/h hay una "zona muerta" intencional: no incrementa
   * ningún contador (evita parpadeo bloqueo/desbloqueo justo en el borde).
   * ===================================================================== */
  function processSample(vKmh) {
    if (vKmh >= LOCK_THRESHOLD_KMH) {
      aboveCount += 1;
      belowCount = 0;
      if (aboveCount >= LOCK_CONSECUTIVE && !locked) lock();
    } else if (vKmh <= UNLOCK_THRESHOLD_KMH) {
      belowCount += 1;
      aboveCount = 0;
      if (belowCount >= UNLOCK_CONSECUTIVE && locked) unlock();
    }
    // en la zona muerta (0.8, 1) no se tocan los contadores
  }

  /* =====================================================================
   * CAPTURA DE SENSORES (event-driven, trabajo mínimo por evento)
   * Los listeners solo guardan el último valor; toda la integración
   * "pesada" ocurre una vez cada 50 ms dentro del loop de rAF.
   * ===================================================================== */
  function onDeviceMotion(e) {
    // Se prefiere 'acceleration' (ya sin gravedad); si no está disponible,
    // se usa 'accelerationIncludingGravity' y se resta la gravedad con un
    // filtro paso-bajo por eje (la gravedad cambia de dirección lentamente
    // al inclinar el teléfono; el movimiento real cambia rápido, así que
    // separarlos por frecuencia es más preciso que restar 9.8 a la magnitud).
    const linear = e.acceleration && e.acceleration.x != null;
    const a = linear ? e.acceleration : e.accelerationIncludingGravity;
    if (!a || a.x == null) return;

    motionSupported = true;

    let lx, ly, lz;
    if (linear) {
      lx = a.x || 0; ly = a.y || 0; lz = a.z || 0;
    } else {
      const rx = a.x || 0, ry = a.y || 0, rz = a.z || 0;
      if (!gravity.ready) {
        gravity.x = rx; gravity.y = ry; gravity.z = rz;
        gravity.ready = true;
      } else {
        gravity.x = GRAVITY_FILTER_ALPHA * gravity.x + (1 - GRAVITY_FILTER_ALPHA) * rx;
        gravity.y = GRAVITY_FILTER_ALPHA * gravity.y + (1 - GRAVITY_FILTER_ALPHA) * ry;
        gravity.z = GRAVITY_FILTER_ALPHA * gravity.z + (1 - GRAVITY_FILTER_ALPHA) * rz;
      }
      lx = rx - gravity.x; ly = ry - gravity.y; lz = rz - gravity.z;
    }

    latestAccel = { x: lx, y: ly, z: lz, hasData: true, isLinear: linear };
    sourceReadout.textContent = linear ? 'Acelerómetro (lineal)' : 'Acelerómetro (+gravedad, filtrada)';
  }

  function onDeviceOrientation(e) {
    // Solo se usa como respaldo si NO llegan eventos devicemotion útiles
    // (regla 1: "en su defecto caída brusca de la orientación").
    if (motionSupported) return;

    const t = performance.now();
    const beta = e.beta || 0;
    const gamma = e.gamma || 0;

    if (lastOrientationSample) {
      const dt = (t - lastOrientationSample.t) / 1000;
      if (dt > 0) {
        const dBeta = Math.abs(beta - lastOrientationSample.beta);
        const dGamma = Math.abs(gamma - lastOrientationSample.gamma);
        orientationRate = (dBeta + dGamma) / dt; // grados/seg
        sourceReadout.textContent = 'Orientación (respaldo)';
      }
    }
    lastOrientationSample = { beta, gamma, t };
  }

  /* =====================================================================
   * INTEGRACIÓN: aceleración -> velocidad (una vez cada 50 ms)
   * ===================================================================== */
  function integrateStep(dtSeconds) {
    let ax = 0, ay = 0, az = 0;

    if (latestAccel.hasData) {
      // Deadband POR EJE (no sobre la magnitud): filtra el ruido/temblor de
      // mano en cada componente antes de integrar, con signo.
      ax = Math.abs(latestAccel.x) < NOISE_DEADBAND_MS2 ? 0 : latestAccel.x;
      ay = Math.abs(latestAccel.y) < NOISE_DEADBAND_MS2 ? 0 : latestAccel.y;
      az = Math.abs(latestAccel.z) < NOISE_DEADBAND_MS2 ? 0 : latestAccel.z;
    } else {
      // Fallback por orientación: convierte velocidad angular en un pseudo
      // valor de aceleración lineal inyectado en un solo eje ficticio. Es
      // una aproximación de relleno, no una medición física real (regla 6).
      const pseudo = orientationRate * ORIENTATION_FALLBACK_SCALE;
      orientationRate *= 0.5; // decae tras el pico para no quedar "pegado"
      ax = pseudo < NOISE_DEADBAND_MS2 ? 0 : pseudo;
    }

    if (ax === 0 && ay === 0 && az === 0) {
      stillCount += 1;
    } else {
      stillCount = 0;
    }

    if (stillCount >= STILL_RESET_SAMPLES) {
      // El sensor lleva >=100ms sin registrar nada por encima del ruido:
      // se fuerza la velocidad a 0 en vez de esperar a que decaiga sola.
      // Esto es lo que evita que sostener el teléfono quieto en la mano
      // termine bloqueando el sistema por deriva acumulada.
      vx = vy = vz = 0;
    } else {
      // v += a*dt CON SIGNO por eje, luego amortiguación. Al ser con signo,
      // la vibración que oscila hacia ambos lados se cancela sola en vez
      // de sumar velocidad siempre (que es lo que pasaba al integrar la
      // magnitud, que nunca es negativa).
      vx = (vx + ax * dtSeconds) * VELOCITY_DECAY;
      vy = (vy + ay * dtSeconds) * VELOCITY_DECAY;
      vz = (vz + az * dtSeconds) * VELOCITY_DECAY;
    }

    const speedMs = Math.sqrt(vx * vx + vy * vy + vz * vz);
    velocityKmh = speedMs * 3.6;
  }

  /* =====================================================================
   * UI (relleno) — throttled aparte de la integración para no gastar
   * ciclos innecesarios en reflow/repintado.
   * ===================================================================== */
  function updateUI() {
    velReadout.textContent = velocityKmh.toFixed(2) + ' km/h';
    stateReadout.textContent = locked ? 'BLOQUEADO' : 'DESBLOQUEADO';
    stateReadout.className = 'value ' + (locked ? 'state-locked' : 'state-unlocked');
    countReadout.textContent = `${aboveCount} / ${belowCount}`;

    chartHistory.push(velocityKmh);
    chartHistory.shift();
    drawFillerChart();
  }

  function drawFillerChart() {
    const w = chartCtx.canvas.width, h = chartCtx.canvas.height;
    chartCtx.clearRect(0, 0, w, h);
    chartCtx.strokeStyle = '#4f7cff';
    chartCtx.lineWidth = 2;
    chartCtx.beginPath();
    const max = 3; // km/h, escala fija del gráfico de relleno
    chartHistory.forEach((v, i) => {
      const x = (i / (chartHistory.length - 1)) * w;
      const y = h - Math.min(v / max, 1) * h;
      i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
    });
    chartCtx.stroke();
  }

  /* =====================================================================
   * LOOP PRINCIPAL (requestAnimationFrame)
   * Un único loop liviano: compara timestamps y solo hace trabajo real
   * cada 50 ms (integración) o cada 100 ms (UI). El resto de los frames
   * el loop no hace nada más que la comprobación de tiempo, así que el
   * costo de CPU/batería es mínimo (regla 5).
   * ===================================================================== */
  function loop(now) {
    requestAnimationFrame(loop);

    if (now - lastIntegrationTime >= SAMPLE_INTERVAL_MS) {
      const dt = (now - lastIntegrationTime) / 1000;
      lastIntegrationTime = now;

      if (simulationMode) {
        // En simulación, el slider fija la velocidad directamente; se
        // respeta igual la cadencia de 50ms para el conteo de muestras.
        velocityKmh = simulatedVelocity;
      } else {
        integrateStep(dt);
      }
      processSample(velocityKmh);
    }

    if (now - lastUIUpdateTime >= UI_REFRESH_MS) {
      lastUIUpdateTime = now;
      updateUI();
    }
  }

  /* =====================================================================
   * PERMISOS / ARRANQUE DE SENSORES
   * iOS 13+ exige que requestPermission() se llame desde un gesto del
   * usuario (click). Android y desktop no requieren este paso.
   * ===================================================================== */
  function attachSensors() {
    window.addEventListener('devicemotion', onDeviceMotion, { passive: true });
    window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });
    sensorBadge.textContent = 'sensores activos';
    sensorBadge.classList.add('on');
    sourceReadout.textContent = 'Esperando datos…';
  }

  async function requestMotionPermission() {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      try {
        const result = await DME.requestPermission();
        if (result === 'granted') {
          attachSensors();
        } else {
          sensorBadge.textContent = 'permiso denegado';
        }
      } catch (err) {
        sensorBadge.textContent = 'error de permiso';
      }
    } else if ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window) {
      attachSensors(); // Android / navegadores que no piden permiso explícito
    } else {
      sensorBadge.textContent = 'no soportado';
    }
  }

  btnPermission.addEventListener('click', () => {
    btnPermission.disabled = true;
    requestMotionPermission();
  });

  /* =====================================================================
   * MODO SIMULACIÓN (para probar sin mover el dispositivo)
   * ===================================================================== */
  simToggle.addEventListener('change', () => {
    simulationMode = simToggle.checked;
    simSlider.disabled = !simulationMode;
    simBadge.textContent = simulationMode ? 'simulación on' : 'simulación off';
    simBadge.classList.toggle('on', simulationMode);
    if (simulationMode) {
      sourceReadout.textContent = 'Slider (simulación)';
    }
  });

  simSlider.addEventListener('input', () => {
    simulatedVelocity = parseFloat(simSlider.value);
    simValue.textContent = simulatedVelocity.toFixed(1) + ' km/h';
  });

  /* =====================================================================
   * ARRANQUE
   * ===================================================================== */
  lastIntegrationTime = performance.now();
  lastUIUpdateTime = performance.now();
  requestAnimationFrame(loop);
})();
