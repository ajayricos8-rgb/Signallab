import { DerivConnectionCard } from '@/components/deriv-connection-card';

export function SettingsPanel() {
  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4" data-testid="settings-panel">
      {/* Users only see and use the PAT connection section */}
      <DerivConnectionCard />
    </div>
  );
}
