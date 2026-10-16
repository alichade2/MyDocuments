// Image helpers (browser APIs only, no native access).

/** Returns a small JPEG (base64, no prefix) for the given base64 image, or throws if it cannot be decoded. */
export async function createThumbnail(base64, mimeType, maxEdge = 320, quality = 0.72) {
  const img = new Image();
  await new Promise((resolve, reject) => { // onload/onerror: decode() can stall for off-screen images
    img.onload = resolve;
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = `data:${mimeType};base64,${base64}`;
  }); // current WebViews apply EXIF orientation when drawing
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // flatten transparency (PNG/GIF) before JPEG encoding
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}
