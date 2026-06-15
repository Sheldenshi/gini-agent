import { MessagesSquare } from "lucide-react";

// Inline "Reply in thread" affordance — design `R3DC9`. Always visible under a
// main-chat assistant message that does NOT yet host a thread, so the user can
// branch a Slack-style thread off any agent reply. Subtle by default, emphasized
// on hover. Clicking mints a new thread rooted at this message.
export function ReplyInThreadButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-[5px] rounded-lg p-0.5 text-left text-[#8A93A6] transition-colors hover:text-[#4B5563] dark:text-[#6E7890] dark:hover:text-[#9CA0AD]"
    >
      <MessagesSquare className="size-3 shrink-0" />
      <span className="text-[12px] font-medium">Reply in thread</span>
    </button>
  );
}
