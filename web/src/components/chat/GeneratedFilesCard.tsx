"use client";

import { useState } from "react";
import { Download, Eye, FileText, FolderTree } from "lucide-react";
import { FilePreviewDrawer } from "@/components/chat/FilePreviewDrawer";
import { fileRawUrl } from "@/lib/api";
import { fileAccent } from "@/lib/file-accent";

// Grouped attachment card for the files an agent generated in one exchange.
// The chat otherwise buries file_write/file_patch calls inside the collapsed
// tool group, so this surfaces every generated file as one card with a row
// per file (icon swatch, filename, directory, Download + View file). "View
// file" opens the right-side preview drawer for that path.
export function GeneratedFilesCard({ files }: { files: { path: string; toolName: string }[] }) {
  const [openPath, setOpenPath] = useState<string | null>(null);

  return (
    <>
      <div className="flex flex-col rounded-xl border border-[#26272D] bg-[#101116]">
        <div className="flex items-center gap-2.5 border-b border-[#22232A] px-4 py-3">
          <FolderTree className="size-3.5 shrink-0 text-[#7A7A80]" aria-hidden="true" />
          <span className="text-xs font-semibold text-[#9A9AA0]">
            {files.length} file{files.length === 1 ? "" : "s"} generated
          </span>
        </div>
        {files.map((file, index) => (
          <FileRow
            key={file.path}
            path={file.path}
            first={index === 0}
            onView={() => setOpenPath(file.path)}
          />
        ))}
      </div>
      <FilePreviewDrawer path={openPath} onOpenChange={(open) => !open && setOpenPath(null)} />
    </>
  );
}

function FileRow({ path, first, onView }: { path: string; first: boolean; onView: () => void }) {
  const lastSlash = path.lastIndexOf("/");
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dir = lastSlash > 0 ? path.slice(0, lastSlash) : "";
  const accent = fileAccent(path);

  return (
    <div
      className={`flex items-center gap-3.5 px-4 py-3.5 ${first ? "" : "border-t border-[#22232A]"}`}
    >
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-[9px]"
        style={{ backgroundColor: accent.bg }}
        aria-hidden="true"
      >
        <FileText className="size-[19px]" style={{ color: accent.fg }} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate font-mono text-[13px] font-semibold text-white">{filename}</span>
        {dir ? <span className="truncate text-xs text-[#9A9AA0]">{dir}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <a
          href={fileRawUrl(path)}
          download={filename}
          className="flex items-center gap-1.5 rounded-[7px] border border-[#2A2B33] bg-transparent px-2.5 py-1.5 text-xs font-semibold text-[#B6B6BC] transition-colors hover:bg-[#1B1C22]"
        >
          <Download className="size-3.5" aria-hidden="true" />
          Download
        </a>
        <button
          type="button"
          onClick={onView}
          className="flex items-center gap-1.5 rounded-[7px] border border-[#2A3A6A] bg-[#1B2540] px-2.5 py-1.5 text-xs font-semibold text-[#8FB1FF] transition-colors hover:bg-[#22305A]"
        >
          <Eye className="size-3.5" aria-hidden="true" />
          View file
        </button>
      </div>
    </div>
  );
}
