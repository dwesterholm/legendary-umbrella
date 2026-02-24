import { Badge } from "@/components/ui/badge";

interface ComingSoonSectionProps {
  title: string;
}

export function ComingSoonSection({ title }: ComingSoonSectionProps) {
  return (
    <div className="rounded-xl border-2 border-dashed border-warm-gray-200 p-6 opacity-60">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-warm-gray-500">{title}</h3>
        <Badge
          variant="secondary"
          className="bg-warm-gray-100 text-warm-gray-500"
        >
          Kommer snart
        </Badge>
      </div>
    </div>
  );
}
