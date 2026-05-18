/**
 * Block sends when images are attached but the selected model lacks VISION.
 */

import type { ImageData } from '../components/ImageAttachment';
import type { ModelOption } from './modelAuthBridge';

export function validateVisionSend(
    images: ImageData[] | undefined,
    selectedModelId: string,
    models: ModelOption[],
    maxMode: boolean,
): string | null {
    if (!images || images.length === 0) return null;
    if (maxMode || !selectedModelId || selectedModelId === 'auto') return null;

    const model = models.find((m) => m.id === selectedModelId);
    if (!model) return null;
    const caps = model.capabilities ?? [];
    if (caps.includes('VISION')) return null;

    return `「${model.name}」不支持图片输入。请切换到 Auto、开启 Max，或选择带 VISION 能力的模型。`;
}
