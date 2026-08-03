import { Link } from "wouter";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="max-w-sm text-center" data-testid="panel-not-found">
        <Compass className="mx-auto h-8 w-8 text-primary" />
        <h1 className="mt-3 text-lg font-semibold tracking-tight">Route not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This console has two views: operations and setup.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4" data-testid="link-back-home">
          <Link href="/">Back to operations</Link>
        </Button>
      </div>
    </div>
  );
}
