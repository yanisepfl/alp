export function LandingFace() {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center">
      <div
        data-magnet
        className="settle flex items-center gap-2"
      >
        <div
          aria-hidden
          className="h-[64px] w-[64px]"
          style={{
            backgroundColor: "#fff",
            WebkitMaskImage: "url(/logo.png)",
            maskImage: "url(/logo.png)",
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
          }}
        />
        <span
          style={{
            color: "#fff",
            fontFamily: "var(--font-radley)",
            fontSize: "64px",
            lineHeight: 1,
            fontWeight: 400,
            letterSpacing: "-0.02em",
          }}
        >
          alps
        </span>
      </div>
    </div>
  );
}
