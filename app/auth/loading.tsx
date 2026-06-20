import { PageLoader } from "@/app/_components/page-loader";

// Keeps the brand preloader until Auth gets its own layout skeleton.
export default function Loading() {
  return <PageLoader />;
}
