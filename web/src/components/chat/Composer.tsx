"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { uploadImage, uploadUrl, type UploadRef } from "@/lib/api";

interface PendingImage {
  // Local id used to track the item in the list while it uploads. Replaced
  // by the server-assigned UploadRef.id on success.
  localId: string;
  previewUrl: string;
  filename: string;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
  ref?: UploadRef;
}

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (images: UploadRef[]) => void;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  onStop,
  disabled,
  placeholder = "Ask anything"
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  // Auto-grow on value change.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [value]);

  // Revoke object URLs on unmount or when images change. Browsers leak the
  // blob until revokeObjectURL is called.
  useEffect(() => {
    return () => {
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readyRefs = (): UploadRef[] => images.filter((image) => image.ref).map((image) => image.ref!);
  const anyUploading = images.some((image) => image.status === "uploading");
  const canSend =
    !disabled && !busy && !anyUploading && (value.trim().length > 0 || readyRefs().length > 0);

  const submit = () => {
    if (!canSend) return;
    const refs = readyRefs();
    onSubmit(refs);
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const beginUpload = async (file: File): Promise<void> => {
    const localId = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    setImages((prev) => [
      ...prev,
      { localId, previewUrl, filename: file.name, status: "uploading" }
    ]);
    try {
      const ref = await uploadImage(file);
      setImages((prev) =>
        prev.map((image) =>
          image.localId === localId ? { ...image, status: "ready", ref } : image
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Upload failed: ${message}`);
      setImages((prev) =>
        prev.map((image) =>
          image.localId === localId ? { ...image, status: "error", errorMessage: message } : image
        )
      );
    }
  };

  const addFiles = (files: FileList | File[]): void => {
    const list = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (list.length === 0) {
      toast.error("Only image files are supported");
      return;
    }
    for (const file of list) void beginUpload(file);
  };

  const removeImage = (localId: string): void => {
    setImages((prev) => {
      const next = prev.filter((image) => image.localId !== localId);
      const removed = prev.find((image) => image.localId === localId);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  const handleAttachClick = () => fileInputRef.current?.click();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    // Reset so the same file can be picked twice in a row.
    event.target.value = "";
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };
  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (event.dataTransfer.files) addFiles(event.dataTransfer.files);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && file.type.startsWith("image/")) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "relative rounded-[24px] border bg-muted px-4 py-3 shadow-sm transition-colors",
        dragActive && "border-primary bg-accent"
      )}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[24px] border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary">
          Drop image to attach
        </div>
      ) : null}

      {images.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-2">
          {images.map((image) => (
            <li
              key={image.localId}
              className={cn(
                "relative size-16 overflow-hidden rounded-lg border bg-background",
                image.status === "error" && "border-destructive"
              )}
              title={image.filename}
            >
              <img
                src={image.previewUrl}
                alt={image.filename}
                className="size-full object-cover"
              />
              {image.status === "uploading" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-[10px] font-medium uppercase text-muted-foreground">
                  Uploading…
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => removeImage(image.localId)}
                aria-label={`Remove ${image.filename}`}
                className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={placeholder}
        disabled={disabled}
        className="block max-h-32 w-full resize-none border-0 bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      <div className="mt-2 flex items-center justify-between">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={handleAttachClick}
          aria-label="Attach image"
          disabled={disabled}
          className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Paperclip className="size-4" />
        </button>
        {busy ? (
          <button
            type="button"
            onClick={() => onStop?.()}
            aria-label="Stop"
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full text-white transition-colors",
              "bg-destructive hover:opacity-90"
            )}
          >
            <Square className="size-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            aria-label="Send"
            disabled={!canSend}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
              "disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
            )}
          >
            <Send className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function hasFiles(event: React.DragEvent<HTMLDivElement>): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === "Files") return true;
  }
  return false;
}

// Re-uploads using the runtime path. (Kept here so the file's only effect on
// the BFF surface is via /api/runtime/api/uploads — see uploadUrl().)
export { uploadUrl };
