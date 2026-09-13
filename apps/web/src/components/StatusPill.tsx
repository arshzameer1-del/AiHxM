const TONES: Record<string, string> = {
  trial: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  suspended: "bg-red-100 text-red-800",
  churned: "bg-gray-200 text-gray-600",
  locked: "bg-red-100 text-red-800",
};

export function StatusPill({ status }: { status: string }) {
  const tone = TONES[status] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${tone}`}>
      {status}
    </span>
  );
}
