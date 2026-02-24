"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError("Fel e-postadress eller losenord");
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <Card className="border-warm-gray-200">
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-semibold text-warm-gray-900">
          Logga in
        </CardTitle>
        <CardDescription className="text-warm-gray-500">
          Ange din e-postadress och ditt losenord
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-terracotta-50 p-3 text-sm text-terracotta-600">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email" className="text-warm-gray-700">
              E-postadress
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="namn@exempel.se"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="border-warm-gray-200 focus-visible:ring-sage-500"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-warm-gray-700">
              Losenord
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="border-warm-gray-200 focus-visible:ring-sage-500"
            />
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-4">
          <Button
            type="submit"
            className="w-full bg-sage-600 text-white hover:bg-sage-700"
            disabled={loading}
          >
            {loading ? "Loggar in..." : "Logga in"}
          </Button>
          <p className="text-center text-sm text-warm-gray-500">
            Har du inget konto?{" "}
            <Link
              href="/signup"
              className="font-medium text-sage-600 hover:text-sage-700 underline-offset-4 hover:underline"
            >
              Skapa konto
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
