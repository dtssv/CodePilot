export interface MessageImage {
    url: string;
    mimeType?: string;
    description?: string;
    name?: string;
}

export function MessageImages({ images, className = 'msg-images' }: { images: MessageImage[]; className?: string }) {
    if (!images.length) return null;
    return (
        <div className={className}>
            {images.map((img, idx) => (
                <div key={`${img.url.slice(0, 32)}-${idx}`} className="msg-image-item">
                    <img
                        src={img.url}
                        alt={img.description || img.name || `Image ${idx + 1}`}
                        className="msg-image-preview"
                    />
                    {(img.description || img.name) && (
                        <div className="msg-image-desc">{img.description || img.name}</div>
                    )}
                </div>
            ))}
        </div>
    );
}
