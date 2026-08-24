import { NewCaseForm } from "@/components/NewCaseForm";

export default function NewCasePage() {
  return (
    <main className="flex-1 max-w-2xl w-full mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold mb-6">Tạo hồ sơ mới</h1>
      <NewCaseForm />
    </main>
  );
}
