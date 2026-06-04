"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

/** Summary is now embedded in the main dashboard. Redirect to it. */
export default function SummaryRedirect() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  useEffect(() => { router.replace(`/batches/${id}`); }, [router, id]);
  return null;
}
