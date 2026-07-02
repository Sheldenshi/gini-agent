import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center bg-background p-6 text-foreground">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">Page not found</CardTitle>
          <CardDescription>The route you followed does not exist.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" asChild>
            <Link href="/">Back home</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
