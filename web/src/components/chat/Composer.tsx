"use client";

import { useEffect, useRef } from "react";
import { Paperclip, Send, Square } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

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

  // Auto-grow on value change.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (busy || disabled) return;
      if (!value.trim()) return;
      onSubmit();
    }
  };

  const handleAttach = () => {
    toast.message("Attachments are not supported yet");
  };

  return (
    <div className="rounded-[24px] border bg-muted px-4 py-3 shadow-sm">
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className="block max-h-32 w-full resize-none border-0 bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={handleAttach}
          aria-label="Attach"
          className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
            onClick={() => {
              if (!value.trim() || disabled) return;
              onSubmit();
            }}
            aria-label="Send"
            disabled={!value.trim() || disabled}
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
