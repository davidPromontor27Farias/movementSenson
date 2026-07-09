
(function () {
  'use strict';


  const SAMPLE_INTERVAL_MS = 50;  
  const UI_REFRESH_MS      = 100;  

  const GRAVITY_FILTER_ALPHA = 0.8; 
  const STEP_TRIGGER_MS2   = 1.3;  
  const STEP_RESET_MS2     = 0.7;  
  const STEP_REFRACTORY_MS = 250;  
  const ROTATION_VETO_DPS = 90; 

  const ROTATION_COOLDOWN_MS = 300;


  const REAL_STEPS_TO_LOCK = 5;
  const STEP_MAX_GAP_MS    = 900; 
  const CADENCE_WINDOW_MS = 2000; 

  const UNLOCK_PASSWORD = 'imper2026';

  const ORIENTATION_FALLBACK_SCALE = 0.35; 

  let cadenceSpm = 0;
  let stepTimestamps = [];  
  let totalSteps = 0;
  let inStepPulse = false;

  let lastRealStepTime = -Infinity;  
  let consecutiveRealSteps = 0;      

  let locked = false;

  let motionSupported = false;    
  let latestAccel = { x: 0, y: 0, z: 0, hasData: false, isLinear: false };
  let gravity = { x: 0, y: 0, z: 0, ready: false }; 
  let latestRotationRate = { alpha: 0, beta: 0, gamma: 0, hasData: false }; 

  let lastOrientationSample = null; 
  let orientationRate = 0;          
  let lastRotationTime = -Infinity; 

  let lastIntegrationTime = 0;
  let lastUIUpdateTime = 0;


  const overlay        = document.getElementById('lockOverlay');
  const velReadout      = document.getElementById('velReadout');   
  const stateReadout    = document.getElementById('stateReadout');
  const sourceReadout   = document.getElementById('sourceReadout');
  const countReadout    = document.getElementById('countReadout'); 
  const streakReadout   = document.getElementById('streakReadout'); 
  const btnPermission   = document.getElementById('btnPermission');
  const sensorBadge     = document.getElementById('sensorBadge');
  const chartCanvas      = document.getElementById('fillerChart');
  const chartCtx        = chartCanvas ? chartCanvas.getContext('2d') : null;
  const chartHistory     = new Array(80).fill(0);


  const unlockForm      = document.getElementById('unlockForm');
  const unlockPassword  = document.getElementById('unlockPassword');
  const unlockError     = document.getElementById('unlockError');

  
  function lock() {
    if (locked) return;
    locked = true;
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
      if (unlockPassword) {
        unlockPassword.value = '';
        if (unlockError) unlockError.textContent = '';
        unlockPassword.focus();
      }
    });
  }

  function unlock() {
    if (!locked) return;
    locked = false;
    consecutiveRealSteps = 0; // exige una racha nueva de REAL_STEPS_TO_LOCK si vuelve a caminar
    requestAnimationFrame(() => {
      overlay.classList.remove('visible');
      overlay.setAttribute('aria-hidden', 'true');
    });
  }


  if (unlockForm) {
    unlockForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const entered = unlockPassword ? unlockPassword.value : '';
      if (entered === UNLOCK_PASSWORD) {
        unlock();
      } else {
        if (unlockError) unlockError.textContent = 'Contraseña incorrecta';
        if (unlockPassword) {
          unlockPassword.value = '';
          unlockPassword.focus();
        }
      }
    });
  }


  function registerRealStep(now) {
    const gapFromPrevious = now - lastRealStepTime;
    lastRealStepTime = now;
    stepTimestamps.push(now);
    totalSteps += 1;

    if (gapFromPrevious <= STEP_MAX_GAP_MS) {
      consecutiveRealSteps += 1;
    } else {
      consecutiveRealSteps = 1; // primer paso de una posible nueva racha de caminata
    }

    if (consecutiveRealSteps >= REAL_STEPS_TO_LOCK && !locked) {
      lock();
    }
  }


  function onDeviceMotion(e) {

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
    if (sourceReadout) sourceReadout.textContent = linear ? 'Acelerómetro (lineal)' : 'Acelerómetro (+gravedad, filtrada)';

   
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
        if (sourceReadout) sourceReadout.textContent = 'Orientación (respaldo)';
      }
    }
    lastOrientationSample = { beta, gamma, t };
  }

  /* =====================================================================
   * DETECCIÓN DE PASOS Y CÁLCULO DE CADENCIA (una vez cada 50 ms)
   * ===================================================================== */
  function detectStep(magnitude, now) {
    if (!inStepPulse) {
      if (magnitude >= STEP_TRIGGER_MS2 && (now - lastRealStepTime) >= STEP_REFRACTORY_MS) {
        inStepPulse = true;
        registerRealStep(now);
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
    let magnitude;
    if (latestAccel.hasData) {
      magnitude = Math.sqrt(
        latestAccel.x * latestAccel.x +
        latestAccel.y * latestAccel.y +
        latestAccel.z * latestAccel.z
      );
    } else {

      magnitude = orientationRate * ORIENTATION_FALLBACK_SCALE;
      orientationRate *= 0.5; // decae tras el pico para no quedar "pegado"
    }

    if (isRotatingInPlace()) {

      lastRotationTime = now;
      inStepPulse = false;
    } else if (now - lastRotationTime < ROTATION_COOLDOWN_MS) {

      inStepPulse = false;
    } else {
      detectStep(magnitude, now);
    }
    computeCadence(now);

    if (now - lastRealStepTime > STEP_MAX_GAP_MS) {
      consecutiveRealSteps = 0;
    }
  }


  function updateUI() {
    // Todo lo de aquí abajo es el dashboard de RELLENO de este prototipo
    // (cadencia, estado, pasos, gráfica). Ninguno es necesario para que el
    // bloqueo funcione — por eso están guardados con `if`: al integrar
    // esto en un sistema real, se pueden omitir sin que el script truene.
    if (velReadout) velReadout.textContent = Math.round(cadenceSpm) + ' pasos/min';
    if (stateReadout) {
      stateReadout.textContent = locked ? 'BLOQUEADO' : 'DESBLOQUEADO';
      stateReadout.className = 'value ' + (locked ? 'state-locked' : 'state-unlocked');
    }
    if (countReadout) countReadout.textContent = String(totalSteps);
    if (streakReadout) {
      streakReadout.textContent = consecutiveRealSteps + ' / ' + REAL_STEPS_TO_LOCK;
    }

    chartHistory.push(cadenceSpm);
    chartHistory.shift();
    drawFillerChart();
  }

  function drawFillerChart() {
    if (!chartCtx) return;
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


  function setSensorBadge(text) {
    if (!sensorBadge) return;
    sensorBadge.textContent = text;
  }

  function attachSensors() {
    window.addEventListener('devicemotion', onDeviceMotion, { passive: true });
    window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });
    setSensorBadge('sensores activos');
    if (sensorBadge) sensorBadge.classList.add('on');
    if (sourceReadout) sourceReadout.textContent = 'Esperando datos…';
  }

  async function requestMotionPermission() {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      try {
        const result = await DME.requestPermission();
        if (result === 'granted') {
          attachSensors();
        } else {
          setSensorBadge('permiso denegado');
        }
      } catch (err) {
        setSensorBadge('error de permiso');
      }
    } else if ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window) {
      attachSensors();
    } else {
      setSensorBadge('no soportado');
    }
  }

  // btnPermission SÍ es necesario en algún lado: iOS exige que
  // requestMotionPermission() se llame desde un gesto del usuario (click).
  // Si el sistema destino no tiene este botón, hay que invocar
  // requestMotionPermission() desde el gesto de usuario que exista ahí
  // (p. ej. un botón de "Entrar" o "Iniciar turno").
  if (btnPermission) {
    btnPermission.addEventListener('click', () => {
      btnPermission.disabled = true;
      requestMotionPermission();
    });
  }


  lastIntegrationTime = performance.now();
  lastUIUpdateTime = performance.now();
  requestAnimationFrame(loop);
})();
