
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

  const GRAVITY = 9.80665;           // m/s^2, para restar gravedad si solo hay accelerationIncludingGravity
  const NOISE_DEADBAND_MS2 = 0.12;   // acelerómetros MEMS tienen ruido en reposo; por debajo de esto se trata como 0
  // La integración pura (v = v0 + a*dt) diverge con el tiempo porque el ruido
  // del sensor se acumula (deriva / "integration drift"). Para que el
  // prototipo sea utilizable se aplica un factor de amortiguación en cada
  // paso: es una aproximación, NO un filtro de Kalman ni un ZUPT real.
  // En un sistema de producción esto se reemplazaría por fusión de sensores.
  const VELOCITY_DECAY = 0.96;

  const ORIENTATION_FALLBACK_SCALE = 0.35; // escala empírica: grados/seg -> pseudo m/s^2

  /* =====================================================================
   * ESTADO
   * ===================================================================== */
  let velocityKmh = 0;
  let aboveCount = 0;
  let belowCount = 0;
  let locked = false;

  let motionSupported = false;      // true en cuanto llega al menos un evento devicemotion útil
  let latestAccel = { x: 0, y: 0, z: 0, hasData: false, isLinear: false };

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
    // se usa 'accelerationIncludingGravity' y se resta la gravedad luego.
    const linear = e.acceleration && e.acceleration.x != null;
    const a = linear ? e.acceleration : e.accelerationIncludingGravity;
    if (!a || a.x == null) return;

    motionSupported = true;
    latestAccel = { x: a.x || 0, y: a.y || 0, z: a.z || 0, hasData: true, isLinear: linear };
    sourceReadout.textContent = linear ? 'Acelerómetro (lineal)' : 'Acelerómetro (+gravedad)';
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
    let linearAccel;

    if (latestAccel.hasData) {
      const mag = Math.sqrt(
        latestAccel.x * latestAccel.x +
        latestAccel.y * latestAccel.y +
        latestAccel.z * latestAccel.z
      );
      linearAccel = latestAccel.isLinear ? mag : Math.abs(mag - GRAVITY);
    } else {
      // Fallback por orientación: convierte velocidad angular en un pseudo
      // valor de aceleración lineal. Es una aproximación de relleno, no
      // una medición física real (regla 6).
      linearAccel = orientationRate * ORIENTATION_FALLBACK_SCALE;
      orientationRate *= 0.5; // decae tras el pico para no quedar "pegado"
    }

    if (linearAccel < NOISE_DEADBAND_MS2) linearAccel = 0;

    let velocityMs = (velocityKmh / 3.6) + linearAccel * dtSeconds;
    velocityMs *= VELOCITY_DECAY; // amortiguación anti-deriva (ver comentario en configuración)
    velocityKmh = Math.max(0, velocityMs * 3.6);
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
