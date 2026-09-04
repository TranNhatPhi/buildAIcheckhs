"use client";

import dynamic from "next/dynamic";

const ThreeDocumentCanvas = dynamic(() => import("@/components/ThreeDocumentCanvas"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full rounded-3xl bg-gradient-to-br from-indigo-200/30 to-cyan-200/20 motion-safe:animate-pulse" />
  ),
});

type Props = {
  cheDo?: "tong-quan" | "xu-ly";
  tienDo?: number;
  className?: string;
};

/** Lớp tải trễ để Three.js không nằm trong gói JavaScript khởi tạo của trang. */
export function DocumentScene3D({ cheDo = "tong-quan", tienDo = 0, className = "" }: Props) {
  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-br from-indigo-950 via-indigo-900 to-slate-950 ${className}`}
      role="img"
      aria-label={
        cheDo === "xu-ly"
          ? `Mô phỏng máy quét hồ sơ 3D, tiến độ ${Math.round(tienDo)}%`
          : "Mô phỏng các tài liệu số đang chuyển động trong không gian 3D"
      }
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(99,102,241,0.28),transparent_52%)]" />
      <ThreeDocumentCanvas cheDo={cheDo} tienDo={tienDo} />
    </div>
  );
}
