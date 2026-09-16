import RemixStudio from "@/components/remix-studio";

export default function Home() {
  return (
    <>
      <RemixStudio />
      <div
        aria-label="Full playlist build deployed"
        style={{
          position: "fixed",
          right: 14,
          bottom: 14,
          zIndex: 50,
          padding: "7px 10px",
          borderRadius: 999,
          border: "1px solid rgba(30, 215, 96, .35)",
          background: "rgba(7, 8, 6, .88)",
          color: "#b8f7cd",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          backdropFilter: "blur(10px)",
        }}
      >
        Full Playlist Build
      </div>
    </>
  );
}
