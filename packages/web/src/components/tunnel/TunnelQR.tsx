import { QRCodeSVG } from "qrcode.react";
import { cn } from "@/lib/utils";

/**
 * Live QR for the connected-tunnel popover. Encodes the public tunnel URL so
 * scanning it on a phone opens the tunnel directly.
 *
 * Phone scanners need dark modules on a light field with a quiet-zone margin, so
 * the code is always rendered black-on-white inside a white chip regardless of
 * theme — a `currentColor`/transparent QR reads as an un-scannable inverted code
 * in dark mode. The white chip IS the QR's required light field, not decoration.
 */
export function TunnelQR({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("grid place-items-center rounded-xl bg-white p-4", className)}>
      <QRCodeSVG
        value={value}
        size={148}
        level="L"
        marginSize={0}
        bgColor="#ffffff"
        fgColor="#000000"
        title="Tunnel QR code"
        className="h-full w-full"
      />
    </div>
  );
}
