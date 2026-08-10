import dynamic from "next/dynamic";

const SuppChecker = dynamic(() => import("../supp-checker"), { ssr: false });

export default function Home() {
  return <SuppChecker />;
}

