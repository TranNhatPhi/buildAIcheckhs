import { TranslationCheck } from "@/components/TranslationCheck";

export default function TranslationCheckPage() {
  return (
    <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold mb-2">Kiểm tra hồ sơ dịch thuật</h1>
      <p className="text-sm text-neutral-500 mb-6">
        Nhập họ tên của hồ sơ, gửi cả bộ bản dịch lên để kiểm tra cách dịch họ tên, số giấy tờ, ngày tháng có thống
        nhất và đúng quy ước không.
      </p>
      <TranslationCheck />
    </main>
  );
}
