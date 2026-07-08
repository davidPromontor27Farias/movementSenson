
(function () {
  'use strict';

  /* =====================================================================
   * CONFIGURACIÓN
   * ---------------------------------------------------------------------
   * Enfoque: en vez de integrar la aceleración dos veces para estimar una
   * velocidad en km/h (poco confiable con un acelerómetro de mano — ver
   * historial del proyecto), se detectan PASOS por su firma característica
   * (picos rítmicos de aceleración) y se bloquea según la CADENCIA
   * (pasos/min), igual que un podómetro. Esto distingue de forma natural
   * "la tablet se sacude un poco mientras se usa parado" (sin ritmo de
   * pasos) de "la persona está caminando rápido" (pasos periódicos y
   * sostenidos), que es el riesgo real que se quiere evitar en el
   * almacén.
   * ===================================================================== */
  const SAMPLE_INTERVAL_MS = 50;   // cadencia de muestreo/detección
  const UI_REFRESH_MS      = 100;  // refresco visual (no crítico, ahorra batería)

  const GRAVITY_FILTER_ALPHA = 0.8; // filtro paso-bajo para estimar gravedad cuando no hay 'acceleration' lineal

  // --- Detección de pasos ----------------------------------------------
  // Un paso se cuenta como un cruce de umbral tipo "Schmitt trigger": hay
  // que superar STEP_TRIGGER_MS2 para "armar" el paso y volver a bajar de
  // STEP_RESET_MS2 antes de poder contar el siguiente. Eso evita contar
  // el mismo impacto de pie dos veces por el rebote de la señal. El
  // refractario adicional (STEP_REFRACTORY_MS) respeta que un humano no
  // puede dar más de ~4 pasos por segundo.
  // NOTA: estos valores dependen de cómo se transporta la tablet (en
  // mano, en carrito, con correa); hay que calibrarlos con el
  // dispositivo/soporte real antes de usarlo en el almacén.
  const STEP_TRIGGER_MS2   = 1.3;  // m/s^2 (sin gravedad) para armar un paso
  const STEP_RESET_MS2     = 0.7;  // m/s^2 para poder detectar el siguiente
  const STEP_REFRACTORY_MS = 250;  // separación mínima entre pasos contados

  // --- Veto por rotación (girar sobre el propio eje) --------------------
  // El acelerómetro solo mide magnitud de aceleración: girar el torso o la
  // muñeca sin caminar también produce picos que el detector de pasos
  // puede confundir con pasos. El giroscopio (rotationRate) sí distingue
  // "rotar" de "trasladarse caminando", así que mientras la velocidad
  // angular del dispositivo sea alta, se ignoran los pasos candidatos.
  // Si el navegador/dispositivo no reporta rotationRate, este veto queda
  // inactivo y el comportamiento cae de vuelta al de solo-acelerómetro.
  const ROTATION_VETO_DPS = 90; // grados/seg; por encima de esto se considera "girando", no caminando

  // Tras dejar de girar, se siguen ignorando pasos candidatos este tiempo.
  // El frenado brusco de un giro (torso/muñeca) genera un pico de
  // aceleración justo cuando la velocidad angular ya volvió a bajar del
  // umbral, y ese pico por sí solo puede leerse como el inicio de un paso.
  const ROTATION_COOLDOWN_MS = 300;

  // --- Cadencia y umbrales de bloqueo ------------------------------------
  const CADENCE_WINDOW_MS   = 2000; // ventana deslizante para pasos/min
  const FAST_WALK_LOCK_SPM  = 30;   // cadencia = "caminar rápido" -> bloquea (calibrado para este caso de uso)
  const SLOW_WALK_UNLOCK_SPM = 20;  // cadencia por debajo de esto -> ya no es caminata rápida
  // Entre 20 y 30 spm hay una zona muerta intencional (histéresis) para
  // no parpadear bloqueo/desbloqueo justo en el borde.

  // BUG que causaba el bloqueo al girar sobre el propio eje: con
  // CADENCE_WINDOW_MS = 2000, cadenceSpm = pasos_en_ventana * 30. Un único
  // pico falso (p. ej. al girar el cuerpo con el dispositivo en mano) ya
  // arroja 30 spm y se sostiene hasta 2s en la ventana — tiempo de sobra
  // para cumplir LOCK_SUSTAIN_MS (1.5s) SIN que la persona haya caminado
  // un solo paso real. Se exige un mínimo de pasos reales y rítmicos
  // dentro de la ventana antes de considerar válida la cadencia de
  // bloqueo, para que un giro puntual (1-2 picos, sin ritmo sostenido) no
  // baste para bloquear.
  const MIN_STEPS_FOR_LOCK = 3;

  // Cuánto tiempo debe sostenerse la condición antes de actuar. Bloquear
  // requiere más tiempo sostenido que desbloquear: un par de pasos rápidos
  // sueltos (esquivar algo, acomodarse) no debe bloquear la tablet, pero
  // en cuanto deja de caminar rápido se quiere restaurar el acceso pronto.
  const LOCK_SUSTAIN_MS   = 1500;
  const UNLOCK_SUSTAIN_MS = 500;
  const LOCK_CONSECUTIVE   = Math.round(LOCK_SUSTAIN_MS / SAMPLE_INTERVAL_MS);
  const UNLOCK_CONSECUTIVE = Math.round(UNLOCK_SUSTAIN_MS / SAMPLE_INTERVAL_MS);

  const ORIENTATION_FALLBACK_SCALE = 0.35; // escala empírica: grados/seg -> pseudo m/s^2

  /* =====================================================================
   * ESTADO
   * ===================================================================== */
  let cadenceSpm = 0;
  let stepTimestamps = [];  // timestamps (performance.now()) de pasos dentro de la ventana
  let totalSteps = 0;
  let inStepPulse = false;
  let lastStepTime = -Infinity;

  let aboveCount = 0;
  let belowCount = 0;
  let locked = false;

  let motionSupported = false;      // true en cuanto llega al menos un evento devicemotion útil
  let latestAccel = { x: 0, y: 0, z: 0, hasData: false, isLinear: false };
  let gravity = { x: 0, y: 0, z: 0, ready: false }; // estimación de gravedad (filtro paso-bajo) por eje
  let latestRotationRate = { alpha: 0, beta: 0, gamma: 0, hasData: false }; // giroscopio, para vetar giros en el sitio

  let lastOrientationSample = null; // {beta, gamma, t}
  let orientationRate = 0;          // grados/seg, decae solo (ver tick())
  let lastRotationTime = -Infinity; // performance.now() del último tick detectado como giro (para el cooldown)

  let simulationMode = false;
  let simulatedCadence = 0;

  let lastIntegrationTime = 0;
  let lastUIUpdateTime = 0;

  /* =====================================================================
   * DOM
   * ===================================================================== */
  const overlay        = document.getElementById('lockOverlay');
  const velReadout      = document.getElementById('velReadout');   // ahora muestra cadencia (pasos/min)
  const stateReadout    = document.getElementById('stateReadout');
  const sourceReadout   = document.getElementById('sourceReadout');
  const countReadout    = document.getElementById('countReadout'); // ahora muestra pasos totales
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
   * el siguiente frame de pintado (~16 ms a 60Hz): una vez que el sistema
   * DECIDE bloquear o desbloquear, la capa aparece/desaparece casi
   * instantáneamente. La latencia real está en decidir (ver
   * LOCK_SUSTAIN_MS / UNLOCK_SUSTAIN_MS arriba), no en pintar la capa.
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
   * MÁQUINA DE HISTÉRESIS (sobre cadencia, no velocidad)
   * ===================================================================== */
  function processCadenceSample(spm) {
    // En modo simulación no hay stepTimestamps reales (el slider fija
    // cadenceSpm directamente), así que el mínimo de pasos no aplica ahí.
    const hasEnoughSteps = simulationMode || stepTimestamps.length >= MIN_STEPS_FOR_LOCK;

    if (spm >= FAST_WALK_LOCK_SPM && hasEnoughSteps) {
      aboveCount += 1;
      belowCount = 0;
      if (aboveCount >= LOCK_CONSECUTIVE && !locked) lock();
    } else if (spm <= SLOW_WALK_UNLOCK_SPM || !hasEnoughSteps) {
      belowCount += 1;
      aboveCount = 0;
      if (belowCount >= UNLOCK_CONSECUTIVE && locked) unlock();
    }
    // en la zona muerta (20, 30), con suficientes pasos, no se tocan los contadores
  }

  /* =====================================================================
   * CAPTURA DE SENSORES (event-driven, trabajo mínimo por evento)
   * Los listeners solo guardan el último valor; la detección de pasos
   * ocurre una vez cada 50 ms dentro del loop de rAF.
   * ===================================================================== */
  function onDeviceMotion(e) {
    // Se prefiere 'acceleration' (ya sin gravedad); si no está disponible,
    // se usa 'accelerationIncludingGravity' y se resta la gravedad con un
    // filtro paso-bajo por eje (la gravedad cambia de dirección lentamente
    // al inclinar el teléfono/tablet; el movimiento real cambia rápido).
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

    // Giroscopio: si el navegador lo reporta, se guarda para vetar pasos
    // durante rotaciones (girar sobre el propio eje sin caminar).
    const rr = e.rotationRate;
    if (rr && (rr.alpha != null || rr.beta != null || rr.gamma != null)) {
      latestRotationRate = { alpha: rr.alpha || 0, beta: rr.beta || 0, gamma: rr.gamma || 0, hasData: true };
    }
  }

  function isRotatingInPlace() {
    if (!latestRotationRate.hasData) return false; // sin giroscopio: no se puede vetar, se mantiene el comportamiento actual
    const { alpha, beta, gamma } = latestRotationRate;
    const angularSpeed = Math.sqrt(alpha * alpha + beta * beta + gamma * gamma);
    return angularSpeed >= ROTATION_VETO_DPS;
  }

  function onDeviceOrientation(e) {
    // Solo se usa como respaldo si NO llegan eventos devicemotion útiles
    // (regla original: "en su defecto caída brusca de la orientación").
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
   * DETECCIÓN DE PASOS Y CÁLCULO DE CADENCIA (una vez cada 50 ms)
   * ===================================================================== */
  function detectStep(magnitude, now) {
    if (!inStepPulse) {
      if (magnitude >= STEP_TRIGGER_MS2 && (now - lastStepTime) >= STEP_REFRACTORY_MS) {
        inStepPulse = true;
        lastStepTime = now;
        stepTimestamps.push(now);
        totalSteps += 1;
      }
    } else if (magnitude <= STEP_RESET_MS2) {
      inStepPulse = false;
    }
  }

  function computeCadence(now) {
    while (stepTimestamps.length && now - stepTimestamps[0] > CADENCE_WINDOW_MS) {
      stepTimestamps.shift();
    }
    cadenceSpm = stepTimestamps.length * (60000 / CADENCE_WINDOW_MS);
  }

  function tick(now) {
    if (simulationMode) {
      // En simulación, el slider fija la cadencia directamente; se
      // respeta igual la cadencia de 50ms para el conteo de muestras.
      cadenceSpm = simulatedCadence;
    } else {
      let magnitude;
      if (latestAccel.hasData) {
        magnitude = Math.sqrt(
          latestAccel.x * latestAccel.x +
          latestAccel.y * latestAccel.y +
          latestAccel.z * latestAccel.z
        );
      } else {
        // Fallback por orientación: convierte velocidad angular en un
        // pseudo valor de magnitud de aceleración. Aproximación de
        // relleno, no una medición física real.
        magnitude = orientationRate * ORIENTATION_FALLBACK_SCALE;
        orientationRate *= 0.5; // decae tras el pico para no quedar "pegado"
      }

      if (isRotatingInPlace()) {
        // Girando sobre el propio eje: se descarta como candidato a paso y
        // se rearma el pulso, para no contar un "paso" falso justo al
        // terminar el giro (cuando la aceleración vuelve a bajar de golpe).
        lastRotationTime = now;
        inStepPulse = false;
      } else if (now - lastRotationTime < ROTATION_COOLDOWN_MS) {
        // Justo se dejó de girar: el frenado del giro puede producir un
        // pico de aceleración que parece el inicio de un paso. Se sigue
        // descartando un momento más antes de volver a detectar pasos.
        inStepPulse = false;
      } else {
        detectStep(magnitude, now);
      }
      computeCadence(now);
    }
    processCadenceSample(cadenceSpm);
  }

  /* =====================================================================
   * UI (relleno) — throttled aparte de la detección para no gastar
   * ciclos innecesarios en reflow/repintado.
   * ===================================================================== */
  function updateUI() {
    velReadout.textContent = Math.round(cadenceSpm) + ' pasos/min';
    stateReadout.textContent = locked ? 'BLOQUEADO' : 'DESBLOQUEADO';
    stateReadout.className = 'value ' + (locked ? 'state-locked' : 'state-unlocked');
    countReadout.textContent = String(totalSteps);

    chartHistory.push(cadenceSpm);
    chartHistory.shift();
    drawFillerChart();
  }

  function drawFillerChart() {
    const w = chartCtx.canvas.width, h = chartCtx.canvas.height;
    chartCtx.clearRect(0, 0, w, h);
    chartCtx.strokeStyle = '#4f7cff';
    chartCtx.lineWidth = 2;
    chartCtx.beginPath();
    const max = 160; // pasos/min, escala fija del gráfico de relleno
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
   * cada 50 ms (detección) o cada 100 ms (UI). El resto de los frames el
   * loop no hace nada más que la comprobación de tiempo, así que el costo
   * de CPU/batería es mínimo.
   * ===================================================================== */
  function loop(now) {
    requestAnimationFrame(loop);

    if (now - lastIntegrationTime >= SAMPLE_INTERVAL_MS) {
      lastIntegrationTime = now;
      tick(now);
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
   * MODO SIMULACIÓN (para probar sin caminar con el dispositivo)
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
    simulatedCadence = parseFloat(simSlider.value);
    simValue.textContent = Math.round(simulatedCadence) + ' pasos/min';
  });

  /* =====================================================================
   * ARRANQUE
   * ===================================================================== */
  lastIntegrationTime = performance.now();
  lastUIUpdateTime = performance.now();
  requestAnimationFrame(loop);
})();
