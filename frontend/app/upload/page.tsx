"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** This page has been merged into the workspace (/batches). Redirect. */
export default function UploadRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/batches"); }, [router]);
  return null;
}
