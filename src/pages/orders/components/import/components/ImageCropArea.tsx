/**
 * ImageCropArea - интерактивное выделение зоны изображения для анализа
 *
 * Использует react-image-crop для:
 * - Выделения прямоугольной области
 * - Resize через 8 handles (углы + середины сторон)
 * - Overlay (затемнение) вне выделенной области
 * - Масштабирование изображения
 */

import React, { useRef, useCallback } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

interface ImageCropAreaProps {
  imageSrc: string;
  crop: Crop | undefined;
  onCropChange: (crop: Crop) => void;
  onCropComplete: (crop: PixelCrop) => void;
  onImageLoad?: (img: HTMLImageElement) => void;
  scale?: number;
  containerHeight?: number;
}

export const ImageCropArea: React.FC<ImageCropAreaProps> = ({
  imageSrc,
  crop,
  onCropChange,
  onCropComplete,
  onImageLoad,
  scale = 1,
  containerHeight = 350,
}) => {
  const imgRef = useRef<HTMLImageElement>(null);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (onImageLoad) {
      onImageLoad(img);
    }
  }, [onImageLoad]);

  return (
    <div
      className="image-crop-container"
      style={{ height: containerHeight, overflow: 'auto' }}
    >
      <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <ReactCrop
          crop={crop}
          onChange={(c) => onCropChange(c)}
          onComplete={(c) => onCropComplete(c)}
        >
          <img
            ref={imgRef}
            src={imageSrc}
            alt="Preview"
            onLoad={handleImageLoad}
            style={{ display: 'block', maxWidth: 'none' }}
          />
        </ReactCrop>
      </div>

      <style>{`
        .image-crop-container {
          display: flex;
          background: #f5f5f5;
          border-radius: 8px;
          padding: 16px;
        }

        /* Overlay (затемнение вне выделенной области) */
        .ReactCrop__crop-selection {
          border: 2px dashed #1890ff !important;
          box-shadow: 0 0 0 9999em rgba(0, 0, 0, 0.5) !important;
        }

        /* Handles для resize */
        .ReactCrop__drag-handle {
          width: 12px !important;
          height: 12px !important;
          background-color: #1890ff !important;
          border: 2px solid #fff !important;
          border-radius: 50% !important;
        }

        /* Убираем дефолтные стили */
        .ReactCrop__drag-handle::after {
          display: none !important;
        }
      `}</style>
    </div>
  );
};

/**
 * Crop изображение в Blob через Canvas API
 */
export async function cropImageToBlob(
  image: HTMLImageElement,
  crop: PixelCrop,
  mimeType: string = 'image/jpeg',
  quality: number = 0.95
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Учитываем масштаб изображения (natural vs displayed size)
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;

  // Размер canvas = размер выделенной области в натуральных пикселях
  canvas.width = crop.width * scaleX;
  canvas.height = crop.height * scaleY;

  // Рисуем обрезанную область
  ctx.drawImage(
    image,
    crop.x * scaleX,
    crop.y * scaleY,
    crop.width * scaleX,
    crop.height * scaleY,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to create blob from canvas'));
        }
      },
      mimeType,
      quality
    );
  });
}

export default ImageCropArea;
