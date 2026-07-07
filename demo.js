const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');

// PIN de administrador por defecto: "1234". Para cambiarlo, calcula el
// SHA-256 hex del nuevo PIN (por ejemplo con MovementLockUtils.sha256Hex)
// y reemplaza el valor de pinHash.
const lock = new MovementLock({
  thresholdKmH: 1,
  consecutiveSamplesRequired: 3,
  minAccuracyMeters: 30,
  pinHash: '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f',
  onStatus: (msg) => {
    statusEl.textContent = msg;
  },
  onLock: () => {
    statusEl.textContent = 'BLOQUEADO: movimiento detectado.';
  },
  onUnlock: () => {
    statusEl.textContent = 'Desbloqueado. Monitoreo continúa activo.';
  },
});

startBtn.addEventListener('click', () => {
  lock.start();
  startBtn.disabled = true;
  startBtn.textContent = 'Monitoreo activo';
});
