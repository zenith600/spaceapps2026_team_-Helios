import { redirect } from "next/navigation";

// The front door is the challenge tool: the Sky Viewer. The Planet X search (simulated data)
// lives under /hunt, clearly labelled experimental.
export default function Home() {
  redirect("/sky");
}
