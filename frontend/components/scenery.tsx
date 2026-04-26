import Image from "next/image";

export function Scenery({ muted = false }: { muted?: boolean }) {
  return (
    <>
      {/* Outer glow — blurred, slightly oversized copy of the landscape behind
          the panel. Toggled by the `:has()` rule in globals.css when the
          catchphrase link is hovered. */}
      <div
        aria-hidden
        className="scenery-glow pointer-events-none absolute overflow-hidden"
        style={{
          top: "18%",
          right: "18%",
          bottom: "18%",
          left: "18%",
          borderRadius: 24,
          filter: "blur(50px)",
          willChange: "opacity, transform",
        }}
      >
        <Image
          src="/landscape.png"
          alt=""
          fill
          sizes="60vw"
          className="object-cover"
        />
      </div>

      {/* Main landscape panel. Desaturates + dims when `muted` is true so
          overlaid Learn-more copy reads cleanly on top. */}
      <div
        aria-hidden
        className="scenery-panel pointer-events-none absolute overflow-hidden"
        style={{
          top: "20%",
          right: "20%",
          bottom: "20%",
          left: "20%",
          borderRadius: "20px",
          filter: muted
            ? "grayscale(0.85) saturate(0.35) contrast(0.85) brightness(0.55)"
            : "none",
          transition: "filter 1400ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <Image
          src="/landscape.png"
          alt=""
          fill
          priority
          sizes="60vw"
          className="object-cover"
        />
      </div>
    </>
  );
}
