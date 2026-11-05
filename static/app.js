const video = document.queryElementById('source');
const canvas = document.getElementById('video');
const context = canvas.getContext('2d');
const status = document.getElementById('status');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
let stream = null;
let socket = null;
let sendTimer = null;
let captureCanvas = document.createElement('canvas');
let running = false;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function startCamera() {
  startButton.disabled = true;
  setStatus('Waiting for camera permission…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    connect();
    running = true;
    stopButton.disabled = false;
  } catch (error) {
    setStatus(`Camera unavailable: ${error.name === 'NotAllowedError' ? 'permission was denied' : error.message}`, true);
    startButton.disabled = false;
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.binaryType = 'blob';
  setStatus('Connecting to AirPad processing service…');
  socket.onopen = () => {
    setStatus('Connected. Waiting for server and hand model…');
    sendTimer = window.setInterval(sendFrame, 100);
  };
  socket.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') setStatus('Camera active. Show your hand to begin drawing.');
      if (message.type === 'error') setStatus(message.message, true);
      return;
    }
    const bitmap = await createImageBitmap(await event.data);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
  };
  socket.onerror = () => setStatus('A WebSocket connection error occurred.', true);
  socket.onclose = () => {
    if (running) setStatus('Processing connection closed. Camera stopped.', true);
    stopCamera(false);
  };
}

function sendFrame() {
  if (!running || !socket || socket.readyState !== WebSocket.OPEN || video.readyState < 2) return;
  if (socket.bufferedAmount > 750000) return;
  const width = 640;
  const height = Math.round(width * video.videoHeight / video.videoWidth);
  captureCanvas.width = width;
  captureCanvas.height = height;
  const captureContext = captureCanvas.getContext('2d');
  captureContext.drawImage(video, 0, 0, width, height);
  captureCanvas.toBlob((blob) => {
    if (blob && socket && socket.readyState === WebSocket.OPEN) socket.send(blob);
  }, 'image/jpeg', 0.72);
}

function stopCamera(reopen = true) {
  running = false;
  if (sendTimer) clearInterval(sendTimer);
  sendTimer = null;
  if (socket) { socket.close(); socket = null; }
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  stopButton.disabled = true;
  startButton.disabled = !reopen;
  if (reopen) setStatus('Camera stopped.');
}

startButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', () => stopCamera(true));
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return setStatus('Camera must be running to use controls.', true);
    socket.send(JSON.stringify({ action: button.dataset.action }));
  });
});

window.addEventListener('beforeunload', () => stopCamera(false));
