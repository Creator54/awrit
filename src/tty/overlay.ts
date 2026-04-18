import { ShmGraphicBuffer } from 'awrit-native-rs';
import { GFX } from './escapeCodes';
import type { Size } from './graphics';
import { placeCursor } from './output';

const { stdout } = process;

let overlayId = 1000; // Start high to avoid collision

function createArrowBuffer(direction: 'left' | 'right', size: Size): ShmGraphicBuffer {
  const buffer = new ShmGraphicBuffer(size.width * size.height * 4);
  const data = new Uint8ClampedArray(size.width * size.height * 4);
  
  const centerX = size.width / 2;
  const centerY = size.height / 2;
  const radius = Math.min(centerX, centerY) - 2;

  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const idx = (y * size.width + x) * 4;
      
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist <= radius) {
        // Background circle (semi-transparent dark)
        data[idx] = 20;     // R
        data[idx + 1] = 20; // G
        data[idx + 2] = 20; // B
        data[idx + 3] = 180; // A
        
        // Simple Arrow
        const arrowX = direction === 'left' ? x - centerX + 5 : centerX - x + 5;
        const arrowY = Math.abs(y - centerY);
        
        // Arrow head
        if (arrowX > 0 && arrowX < 15 && arrowY < arrowX) {
           data[idx] = 255;
           data[idx+1] = 255;
           data[idx+2] = 255;
           data[idx+3] = 255;
        }
        // Arrow shaft
        if (arrowX >= 15 && arrowX < 30 && arrowY < 3) {
           data[idx] = 255;
           data[idx+1] = 255;
           data[idx+2] = 255;
           data[idx+3] = 255;
        }
      } else {
        data[idx + 3] = 0; // Transparent
      }
    }
  }
  
  buffer.write(Buffer.from(data), size.width);
  return buffer;
}

let currentOverlayId: number | null = null;

export function showNavigationOverlay(direction: 'left' | 'right', windowSize: any) {
  const size = { width: 60, height: 60 };
  const buffer = createArrowBuffer(direction, size);
  const id = overlayId++;
  
  const x = direction === 'left' ? 40 : windowSize.width - 100;
  const y = (windowSize.height / 2) - 30;

  const cellToPxX = windowSize.width / windowSize.cols;
  const cellToPxY = windowSize.height / windowSize.rows;

  const col = Math.floor(x / cellToPxX) + 1;
  const row = Math.floor(y / cellToPxY) + 1;
  const offsetX = Math.floor(x % cellToPxX);
  const offsetY = Math.floor(y % cellToPxY);

  // Position cursor and then place image with pixel-perfect offset
  placeCursor({ x: col, y: row });
  // a=T: Transfer and display
  // f=32: RGBA, t=s: SHM
  // i: image ID, C=1: Do not move cursor
  // X, Y: Pixel offsets from the top-left of the current cell
  stdout.write(GFX`a=T,f=32,t=s,i=${id},C=1,s=${size.width},v=${size.height},X=${offsetX},Y=${offsetY};${buffer.nameBase64}`);
  
  setTimeout(() => {
    // a=d: Delete image by ID
    stdout.write(GFX`a=d,d=i,i=${id}`);
  }, 800);
}
