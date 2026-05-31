import { Dashboard } from "@/components/Dashboard";
import { RealApp } from "@/components/RealApp";

export default function Home() {
  return (
    <div>
      <Dashboard realAppSlot={<RealApp />} />
    </div>
  );
}
