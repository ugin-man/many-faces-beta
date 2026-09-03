import Link from "next/link";
import styles from "./mode-nav.module.css";

export default function ModeNav() {
  return (
    <nav className={styles.nav} aria-label="Many Facesの実験画面">
      <Link href="/">OFFLINE</Link>
      <Link href="/live">REALTIME</Link>
    </nav>
  );
}
