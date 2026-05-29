import type { UserTextBlock } from "@runtime/types";
import { uploadUrl } from "@/lib/api";
import { formatMessageTimestamp } from "./relative-time";

export function BlockUserText({ block }: { block: UserTextBlock }) {
  const timestamp = formatMessageTimestamp(block.createdAt);
  const images = block.images ?? [];
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
      {hasText ? (
        <div className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-xl bg-primary px-3 py-2.5 text-sm leading-snug text-primary-foreground">
          {block.text}
        </div>
      ) : null}
    </div>
  );
}
