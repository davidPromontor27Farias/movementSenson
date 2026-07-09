(function () {

  'use strict';


  // ============== PARÁMETROS DEL SENSOR ==============

  const SAMPLE_INTERVAL_MS         = 50;

  const UI_REFRESH_MS              = 100;

  const GRAVITY_FILTER_ALPHA       = 0.8;

  const STEP_TRIGGER_MS2           = 1.3;     // umbral para detectar paso (m/s²)

  const STEP_RESET_MS2             = 0.7;

  const STEP_REFRACTORY_MS         = 250;     // anti-rebote entre pasos

  const ROTATION_VETO_DPS          = 90;      // ignora pasos si rotas en sitio

  const ROTATION_COOLDOWN_MS       = 300;

  const ORIENTATION_FALLBACK_SCALE = 0.35;   // respaldo sin acelerómetro lineal

  const CADENCE_WINDOW_MS          = 2000;


  // ============== BLOQUEO POR DISTANCIA ==============

  const STEP_LENGTH_M              = 0.70;    // metros estimados por paso

  const TARGET_DISTANCE_M          = 2.0;     // bloqueo al alcanzar 2 m


  // ============== AJUSTE #4: DECAY POR INACTIVIDAD ==============

  const IDLE_DECAY_TIMEOUT_MS      = 30000;   // 30 s sin pasos -> empieza a olvidar

  const IDLE_DECAY_RATE_MS         = 1000;    // aplica cada 1 s

  const IDLE_DECAY_M_PER_TICK      = 0.10;    // 10 cm por segundo de decay


  // ============== AJUSTE #3: LOG DE EVENTOS ==============

  const LOCK_LOG_KEY               = 'accelLock_log';

  const LOCK_LOG_MAX               = 50;


  // ============== SEGURIDAD ==============

  const UNLOCK_PASSWORD            = 'imper2026';


  // ============== ESTADO ==============

  let cumulativeDistanceM  = 0;

  let cadenceSpm           = 0;

  let stepTimestamps       = [];

  let totalSteps           = 0;

  let inStepPulse          = false;

  let lastRealStepTime     = -Infinity;

  let lastStepTimeForIdle  = performance.now();

  let locked               = false;

  let motionSupported      = false;

  let latestAccel          = { x: 0, y: 0, z: 0, hasData: false, isLinear: false };

  let gravity              = { x: 0, y: 0, z: 0, ready: false };

  let latestRotationRate   = { alpha: 0, beta: 0, gamma: 0, hasData: false };

  let lastOrientationSample = null;

  let orientationRate      = 0;

  let lastRotationTime     = -Infinity;

  let lastIntegrationTime  = 0;

  let lastUIUpdateTime     = 0;

  let lastIdleDecayTime    = 0;


  // ============== AJUSTE #3: HELPERS DE LOG ==============

  function readLog()    { try { return JSON.parse(localStorage.getItem(LOCK_LOG_KEY) || '[]'); } catch (_) { return []; } }

  function writeLog(a)  { try { localStorage.setItem(LOCK_LOG_KEY, JSON.stringify(a.slice(-LOCK_LOG_MAX))); } catch (_) {} }

  function logLockEvent(reason, extra) {

    const log = readLog();

    log.push(Object.assign(

      { at: new Date().toISOString(), reason, distanceM: cumulativeDistanceM.toFixed(2), steps: totalSteps },

      extra || {}

    ));

    writeLog(log);

  }

  function lastLogLine() {

    const log = readLog();

    return log.length ? log[log.length - 1] : null;

  }


  // ============== ELEMENTOS UI (todos opcionales) ==============

  const $ = (id) => document.getElementById(id);

  const overlay           = $('lockOverlay');

  const velReadout        = $('velReadout');

  const stateReadout      = $('stateReadout');

  const sourceReadout     = $('sourceReadout');

  const countReadout      = $('countReadout');

  const distanceReadout   = $('distanceReadout');

  const distanceBar       = $('distanceBar');

  const sensorBadge       = $('sensorBadge');

  const lockDot           = $('lockDot');

  const lastEventReadout  = $('lastEventReadout');

  const unlockForm        = $('unlockForm');

  const unlockPassword    = $('unlockPassword');

  const unlockError       = $('unlockError');

  const trackerForm       = $('trackerForm');

  const trackingInput     = $('trackingInput');

  const simStepBtn        = $('simStepBtn');


  // ============== LOCK / UNLOCK ==============

  function lock() {

    if (locked) return;

    locked = true;

    requestAnimationFrame(() => {

      if (overlay) {

        overlay.classList.add('visible');

        overlay.setAttribute('aria-hidden', 'false');

      }

      if (unlockPassword) {

        unlockPassword.value = '';

        if (unlockError) { unlockError.textContent = ''; unlockError.style.color = ''; }

        unlockPassword.focus();

      }


      // -- AJUSTE #2: beep al bloquear --

      try {

        const ctx = new (window.AudioContext || window.webkitAudioContext)();

        const o = ctx.createOscillator();

        const g = ctx.createGain();

        o.connect(g); g.connect(ctx.destination);

        o.frequency.value = 440;

        g.gain.setValueAtTime(0.25, ctx.currentTime);

        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

        o.start(); o.stop(ctx.currentTime + 0.4);

      } catch (_) {}


      // -- AJUSTE #1: vibración al bloquear --

      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);


      updateLockDot();

    });

    // -- AJUSTE #3: registrar en log --

    logLockEvent('cumulative-distance');

  }


  function unlock() {

    if (!locked) return;

    locked = false;

    cumulativeDistanceM = 0;

    lastStepTimeForIdle = performance.now();

    requestAnimationFrame(() => {

      if (overlay) {

        overlay.classList.remove('visible');

        overlay.setAttribute('aria-hidden', 'true');

      }

      updateLockDot();

    });

  }


  if (unlockForm) {

    unlockForm.addEventListener('submit', (ev) => {

      ev.preventDefault();

      const entered = unlockPassword ? unlockPassword.value : '';

      if (entered === UNLOCK_PASSWORD) {

        if (unlockError) { unlockError.style.color = '#57d38c'; unlockError.textContent = '✓ Acceso concedido'; }

        setTimeout(unlock, 250);

      } else {

        if (unlockError) { unlockError.style.color = ''; unlockError.textContent = '✗ Contraseña incorrecta'; }

        if (unlockPassword) { unlockPassword.value = ''; unlockPassword.focus(); }

      }

    });

  }


  if (trackerForm) {

    trackerForm.addEventListener('submit', (ev) => {

      ev.preventDefault();

      const guia = trackingInput ? trackingInput.value.trim() : '';

      if (guia) {

        alert('🔍 Buscando envío: ' + guia + '\n\n(En una versión real, aquí se conectaría al backend.)');

        if (trackingInput) trackingInput.value = '';

      }

    });

  }


  // ============== BOTÓN DE PRUEBA ==============

  if (simStepBtn) {

    simStepBtn.addEventListener('click', () => {

      cumulativeDistanceM += 1.0;

      totalSteps += 1;

      lastStepTimeForIdle = performance.now();

      if (cumulativeDistanceM >= TARGET_DISTANCE_M && !locked) lock();

      updateUI();

    });

  }


  // ============== DETECCIÓN DE PASOS ==============

  function registerRealStep(now) {

    lastRealStepTime = now;

    lastStepTimeForIdle = now;            // reset del temporizador de inactividad

    stepTimestamps.push(now);

    totalSteps += 1;

    cumulativeDistanceM += STEP_LENGTH_M; // acumulamos distancia, no pasos sueltos


    if (cumulativeDistanceM >= TARGET_DISTANCE_M && !locked) {

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

        gravity.x = rx; gravity.y = ry; gravity.z = rz; gravity.ready = true;

      } else {

        gravity.x = GRAVITY_FILTER_ALPHA * gravity.x + (1 - GRAVITY_FILTER_ALPHA) * rx;

        gravity.y = GRAVITY_FILTER_ALPHA * gravity.y + (1 - GRAVITY_FILTER_ALPHA) * ry;

        gravity.z = GRAVITY_FILTER_ALPHA * gravity.z + (1 - GRAVITY_FILTER_ALPHA) * rz;

      }

      lx = rx - gravity.x; ly = ry - gravity.y; lz = rz - gravity.z;

    }

    latestAccel = { x: lx, y: ly, z: lz, hasData: true, isLinear: linear };

    if (sourceReadout) sourceReadout.textContent = linear ? 'Acelerómetro (lineal)' : 'Acelerómetro (+gravedad)';

    const rr = e.rotationRate;

    if (rr && (rr.alpha != null || rr.beta != null || rr.gamma != null)) {

      latestRotationRate = { alpha: rr.alpha || 0, beta: rr.beta || 0, gamma: rr.gamma || 0, hasData: true };

    }

  }


  function isRotatingInPlace() {

    if (!latestRotationRate.hasData) return false;

    const { alpha, beta, gamma } = latestRotationRate;

    return Math.sqrt(alpha * alpha + beta * beta + gamma * gamma) >= ROTATION_VETO_DPS;

  }


  function onDeviceOrientation(e) {

    if (motionSupported) return;

    const t = performance.now();

    const beta = e.beta || 0, gamma = e.gamma || 0;

    if (lastOrientationSample) {

      const dt = (t - lastOrientationSample.t) / 1000;

      if (dt > 0) {

        const dBeta = Math.abs(beta - lastOrientationSample.beta);

        const dGamma = Math.abs(gamma - lastOrientationSample.gamma);

        orientationRate = (dBeta + dGamma) / dt;

        if (sourceReadout) sourceReadout.textContent = 'Orientación (respaldo)';

      }

    }

    lastOrientationSample = { beta, gamma, t };

  }


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

    while (stepTimestamps.length && now - stepTimestamps[0] > CADENCE_WINDOW_MS) stepTimestamps.shift();

    cadenceSpm = stepTimestamps.length * (60000 / CADENCE_WINDOW_MS);

  }


  function tick(now) {

    let magnitude;

    if (latestAccel.hasData) {

      magnitude = Math.sqrt(latestAccel.x * latestAccel.x + latestAccel.y * latestAccel.y + latestAccel.z * latestAccel.z);

    } else {

      magnitude = orientationRate * ORIENTATION_FALLBACK_SCALE;

      orientationRate *= 0.5;

    }

    if (isRotatingInPlace()) { lastRotationTime = now; inStepPulse = false; }

    else if (now - lastRotationTime < ROTATION_COOLDOWN_MS) { inStepPulse = false; }

    else { detectStep(magnitude, now); }

    computeCadence(now);

  }


  // ============== UI ==============

  function updateLockDot() {

    if (!lockDot) return;

    lockDot.classList.remove('on', 'locked');

    if (locked) lockDot.classList.add('locked');

    else if (motionSupported) lockDot.classList.add('on');

  }


  function updateUI() {

    if (velReadout)      velReadout.textContent      = Math.round(cadenceSpm) + ' pasos/min';

    if (stateReadout) {

      stateReadout.textContent = locked ? 'BLOQUEADO' : 'DESBLOQUEADO';

      stateReadout.className   = 'lp-value state-badge ' + (locked ? 'state-locked' : 'state-unlocked');

    }

    if (countReadout)    countReadout.textContent    = String(totalSteps);

    if (distanceReadout) {

      const dist = Math.min(cumulativeDistanceM, TARGET_DISTANCE_M);

      distanceReadout.textContent = dist.toFixed(2) + ' / ' + TARGET_DISTANCE_M.toFixed(1) + ' m';

    }

    if (distanceBar) {

      const pct = Math.min(100, (cumulativeDistanceM / TARGET_DISTANCE_M) * 100);

      distanceBar.style.width = pct + '%';

    }

    if (lastEventReadout) {

      const last = lastLogLine();

      lastEventReadout.textContent = last ? (last.at.substr(11, 8) + ' · ' + last.reason) : '—';

    }

  }


  // ============== LOOP + AJUSTE #4: DECAY ==============

  function loop(now) {

    requestAnimationFrame(loop);


    if (now - lastIntegrationTime >= SAMPLE_INTERVAL_MS) {

      lastIntegrationTime = now;

      tick(now);

    }


    // Decaimiento por inactividad: si pasan >30s sin pasos y aún hay

    // distancia acumulada, la reducimos 10 cm/s hasta llegar a 0.

    if (!locked && cumulativeDistanceM > 0 &&

        now - lastStepTimeForIdle > IDLE_DECAY_TIMEOUT_MS &&

        now - lastIdleDecayTime    >= IDLE_DECAY_RATE_MS) {

      lastIdleDecayTime = now;

      cumulativeDistanceM = Math.max(0, cumulativeDistanceM - IDLE_DECAY_M_PER_TICK);

    }


    if (now - lastUIUpdateTime >= UI_REFRESH_MS) {

      lastUIUpdateTime = now;

      updateUI();

    }

  }


  // ============== SENSORES (INICIO AUTOMÁTICO) ==============

  function setSensorBadge(text) { if (sensorBadge) sensorBadge.textContent = text; }


  function attachSensors() {

    window.addEventListener('devicemotion',      onDeviceMotion,      { passive: true });

    window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });

    setSensorBadge('activos');

    updateLockDot();

    if (sourceReadout) sourceReadout.textContent = 'Esperando datos…';

  }


  function autoStart() {

    const DME = window.DeviceMotionEvent;

    if (typeof DME !== 'undefined' && typeof DME.requestPermission === 'function') {

      // iOS: cualquier click/touch/tecla activa el permiso

      setSensorBadge('toca para activar');

      const handler = async () => {

        document.removeEventListener('click',      handler, true);

        document.removeEventListener('touchstart', handler, true);

        document.removeEventListener('keydown',    handler, true);

        try {

          const result = await DME.requestPermission();

          if (result === 'granted') attachSensors();

          else setSensorBadge('permiso denegado');

        } catch (err) { setSensorBadge('error de permiso'); }

      };

      document.addEventListener('click',      handler, true);

      document.addEventListener('touchstart', handler, true);

      document.addEventListener('keydown',    handler, true);

    } else if ('DeviceMotionEvent' in window || 'DeviceOrientationEvent' in window) {

      attachSensors(); // Android / desktop: inmediato

    } else {

      setSensorBadge('no soportado');

    }

  }


  // ============== KICKOFF ==============

  lastIntegrationTime = performance.now();

  lastUIUpdateTime    = performance.now();

  requestAnimationFrame(loop);

  autoStart();

})();

