// Tiny dependency-free confetti burst for milestone celebrations. Injects a
// handful of coloured pieces into a fixed overlay, lets the CSS animation run,
// then cleans them up. No-op on the server.

const COLORS = ["#1F8A5B", "#0A7BC0", "#534AB7", "#BA7517", "#C0470A", "#B5184A", "#0F6E56"];

export function burstConfetti(count = 48): void {
  if (typeof document === "undefined") return;

  let root = document.querySelector<HTMLElement>(".confetti-root");
  if (!root) {
    root = document.createElement("div");
    root.className = "confetti-root";
    document.body.appendChild(root);
  }

  const pieces: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "confetti-piece";
    const left = Math.random() * 100;
    const dur = 2 + Math.random() * 1.6;
    const delay = Math.random() * 0.3;
    const spin = (Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 540);
    el.style.left = `${left}vw`;
    el.style.background = COLORS[i % COLORS.length];
    el.style.setProperty("--dur", `${dur}s`);
    el.style.setProperty("--delay", `${delay}s`);
    el.style.setProperty("--spin", `${spin}deg`);
    el.style.transform = `scale(${0.7 + Math.random() * 0.8})`;
    root.appendChild(el);
    pieces.push(el);
  }

  const ttl = 4200;
  window.setTimeout(() => {
    for (const el of pieces) el.remove();
    if (root && root.childElementCount === 0) root.remove();
  }, ttl);
}
