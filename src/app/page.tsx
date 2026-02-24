export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <main className="flex flex-col items-center gap-6 text-center p-8">
        <h1 className="text-4xl font-semibold tracking-tight text-warm-gray-900">
          Bostad AI
        </h1>
        <p className="text-lg text-warm-gray-500 max-w-md">
          AI-driven bostadsanalys for svenska bostadskopare.
          Klistra in en Booli-lank och fa en detaljerad analys.
        </p>
      </main>
    </div>
  );
}
