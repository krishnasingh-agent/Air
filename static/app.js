const video = document.getElementById('source');
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
let serverReady = false;
let processedFrameAt = 0;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function startCamera() {
  startButton.disabled = true;
  if (stream && stream.getTracks().some((track) => track.readyState === 'live')) {
    running = true;
    connect();
    stopButton.disabled = false;
    return;
  }
  setStatus('Waiting for camera permission…');
  try {
    if (!window.isSecureContext) {
      throw new Error('camera access requires HTTPS (localhost is also supported)');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('this browser does not support webcam access');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    running = true;
    connect();
    window.requestAnimationFrame(renderPreview);
    stopButton.disabled = false;
  } catch (error) {
    const message = error.name === 'NotAllowedError'
      ? 'permission was denied'
      : error.name === 'NotFoundError'
        ? 'no webcam was found'
        : error.message;
    setStatus(`Camera unavailable: ${message}`, true);
    startButton.disabled = false;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.binaryType = 'blob';
  setStatus('Connecting to AirPad processing service…');
  socket.onopen = () => {
    serverReady = false;
    setStatus('Connected. Waiting for server and hand model…');
    sendTimer = window.setInterval(sendFrame, 250);
  };
  socket.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        serverReady = true;
        setStatus('Camera active. Show your hand to begin drawing.');
      }
      if (message.type === 'error') setStatus(message.message, true);
      return;
    }
    const image = await createImageBitmap(await event.data);
    canvas.width = image.width;
    canvas.height = image.height;
    context.drawImage(image, 0, 0);
    processedFrameAt = performance.now();
    image.close();
  };
  socket.onerror = () => setStatus('A WebSocket connection error occurred.', true);
  socket.onclose = () => {
    if (running) {
      setStatus('Processing connection closed. Camera preview remains on; retry by stopping and starting the camera.', true);
      serverReady = false;
      if (sendTimer) clearInterval(sendTimer);
      sendTimer = null;
      if (socket) socket = null;
      stopButton.disabled = false;
      startButton.disabled = false;
    }
  };
}

function renderPreview() {
  if (!stream) return;
  if (performance.now() - processedFrameAt > 1200 && video.readyState >= 2) {
    if (!canvas.width || !canvas.height) {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
    }
    context.save();
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.restore();
  }
  window.requestAnimationFrame(renderPreview);
}

function sendFrame() {
  if (!running || !serverReady || !socket || socket.readyState !== WebSocket.OPEN || video.readyState < 2) return;
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
  serverReady = false;
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
