"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/format";

export function ConfigBanner() {
  const [status, setStatus] = useState<{ backendUp: boolean; hasDeepseekKey: boolean } | null>(
    null
  );

  useEffect(() => {
    Promise.all([
      fetch(`${API_URL}/health`).then((r) => r.json()),
      fetch(`${API_URL}/config`).then((r) => r.json()),
    ])
      .then(([health, config]) => {
        setStatus({ backendUp: health.status === "ok", hasDeepseekKey: config.hasDeepseekKey });
      })
      .catch(() => setStatus({ backendUp: false, hasDeepseekKey: false }));
  }, []);

  if (!status) return null;
  if (status.backendUp && status.hasDeepseekKey) return null;

  return (
    <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-sm px-4 py-2">
      {!status.backendUp && (
        <p>
          ⚠️ Không kết nối được backend — chạy <code>python -m uvicorn main:app --port 8001</code>{" "}
          trong thư mục <code>backend/</code>.
        </p>
      )}
      {status.backendUp && !status.hasDeepseekKey && (
        <p>⚠️ Thiếu DEEPSEEK_API_KEY — kiểm tra file .env.local.</p>
      )}
    </div>
  );
}
