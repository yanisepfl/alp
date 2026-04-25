import Image from "next/image";

/**
 * The landscape backdrop — a 60% × 60% rounded panel centered on the dark
 * page background. Single, static layout for the brand establishment page.
 */
export function Scenery() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute overflow-hidden"
      style={{
        top: "20%",
        right: "20%",
        bottom: "20%",
        left: "20%",
        borderRadius: "20px",
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
  );
}
