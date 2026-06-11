import { FileText } from "lucide-react";
import type { UserTextBlock } from "@runtime/types";
import { uploadUrl } from "@/lib/api";
import { formatMessageTimestamp } from "./relative-time";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function BlockUserText({ block }: { block: UserTextBlock }) {
  const timestamp = formatMessageTimestamp(block.createdAt);
  const attachments = block.images ?? [];
  const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = attachments.filter((a) => !a.mimeType.startsWith("image/"));
  const hasText = block.text.length > 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 pr-1 text-xs">
        <span className="font-semibold text-foreground">You</span>
        {timestamp ? <span className="text-muted-foreground">{timestamp}</span> : null}
      </div>
      {images.length > 0 ? (
        <ul className="ml-auto flex max-w-[80%] flex-wrap justify-end gap-2">
          {images.map((image) => (
            <li
              key={image.id}
              className="overflow-hidden rounded-lg border bg-background"
            >
              <a
                href={uploadUrl(image.id)}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                <img
                  src={uploadUrl(image.id)}
                  alt="attachment"
                  className="block max-h-64 max-w-[16rem] object-contain"
                />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul className="ml-auto flex max-w-[80%] flex-wrap justify-end gap-2">
          {files.map((file) => (
            <li key={file.id}>
              {/* The persisted block carries no original filename
                  (ImageAttachment is {id, mimeType, size}), so the chip
                  shows the mime subtype + size. A non-image entry must not
                  render as an <img> — it would 404 as a broken image. */}
              <a
                href={uploadUrl(file.id)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs hover:bg-accent"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium text-foreground">
                  {file.mimeType.split("/")[1]?.toUpperCase() ?? file.mimeType}
                </span>
                <span className="text-muted-foreground">{formatBytes(file.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {hasText ? (
        <div className="ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-xl bg-secondary px-3 py-2.5 text-sm leading-snug text-secondary-foreground dark:bg-primary dark:text-primary-foreground">
          {block.text}
        </div>
      ) : null}
    </div>
  );
}
