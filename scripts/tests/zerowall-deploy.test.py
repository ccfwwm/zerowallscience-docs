"""在临时目录替换外部命令，验证真实部署脚本的成功路径和失败数据恢复。"""
import gzip
import io
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "deploy" / "deploy.sh"
OLD = "a" * 40
NEW = "b" * 40


class DeployTest(unittest.TestCase):
    def run_deployment(self, failure):
        with tempfile.TemporaryDirectory(prefix="zerowall-deploy-") as tmp:
            base = Path(tmp)
            root, web, data, nginx, bins = [base / name for name in ("root", "web", "data", "nginx", "bin")]
            for directory in (root / "compose", root / "incoming" / NEW / "nginx", web / "releases" / OLD, data, nginx, bins):
                directory.mkdir(parents=True)
            incoming = root / "incoming" / NEW
            (root / "compose" / ".deployed-sha").write_text(OLD)
            (root / "compose" / "docker-compose.yml").write_text("old compose")
            (incoming / "docker-compose.production.yml").write_text("new compose")
            (web / "current").symlink_to("releases/" + OLD)
            (web / "releases" / OLD / "index.html").write_text("old website")
            for suffix in ("http", "https"):
                name = f"zerowallscience-web.{suffix}.conf"
                (nginx / name).write_text("old nginx")
                (incoming / "nginx" / name).write_text("new nginx")
            with sqlite3.connect(data / "docs.db") as db:
                db.execute("CREATE TABLE notes(content TEXT)")
                db.execute("INSERT INTO notes VALUES ('edited production document')")
            (data / "attachment.txt").write_text("original attachment")
            (incoming / "image.tar.gz").write_bytes(gzip.compress(b"image"))
            with tarfile.open(incoming / "site.tar.gz", "w:gz") as tar:
                for name in ("index.html", "en/index.html"):
                    payload = b"new website"
                    info = tarfile.TarInfo(name)
                    info.size = len(payload)
                    tar.addfile(info, io.BytesIO(payload))

            # 所有服务控制命令均替换，测试不接触宿主 Docker/Nginx。
            stub = '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
name=Path(sys.argv[0]).name
base=Path(os.environ["FIXTURE"])
args=sys.argv[1:]
with (base/"calls").open("a") as log: log.write(name+" "+" ".join(args)+"\\n")
if name=="docker":
 if args[0]=="load": sys.stdin.buffer.read()
 if args[0]=="compose":
  sha=os.environ["DEPLOY_SHA"]
  (base/"running").write_text(sha)
  if sha.startswith("b"):
   (base/"data"/"docs.db").write_bytes(b"failed migration")
   (base/"data"/"attachment.txt").write_text("changed attachment")
   (base/"data"/"new-file").write_text("migration created file")
 if args[0]=="inspect":
  failed=os.environ["FAILURE"]=="health" and (base/"running").read_text().startswith("b")
  print("unhealthy" if failed else "healthy")
elif name=="nginx":
 if os.environ["FAILURE"]=="nginx" and (base/"nginx"/"zerowallscience-web.https.conf").read_text()=="new nginx": sys.exit(1)
'''
            for command in ("docker", "curl", "nginx", "systemctl", "sleep"):
                file = bins / command
                file.write_text(stub)
                file.chmod(0o755)
            script = SOURCE.read_text()
            for actual, fixture in (("/opt/zerowallscience-docs", root), ("/var/www/zerowallscience-web", web), ("/var/lib/zerowallscience-docs/data", data), ("/etc/nginx/conf.d", nginx)):
                script = script.replace(actual, str(fixture))
            candidate = base / "deploy.sh"
            candidate.write_text(script)
            result = subprocess.run(["bash", str(candidate), NEW], env={**os.environ, "PATH": str(bins) + ":" + os.environ["PATH"], "FIXTURE": tmp, "FAILURE": failure}, capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, not failure, result.stdout + result.stderr)
            self.assertFalse((root / "maintenance").exists())
            self.assertEqual((root / "compose" / ".deployed-sha").read_text().strip(), OLD if failure else NEW)
            if failure:
                self.assertEqual(os.readlink(web / "current"), "releases/" + OLD)
                self.assertEqual((root / "compose" / "docker-compose.yml").read_text(), "old compose")
                self.assertEqual((nginx / "zerowallscience-web.https.conf").read_text(), "old nginx")
                self.assertEqual((data / "attachment.txt").read_text(), "original attachment")
                self.assertFalse((data / "new-file").exists())
                with sqlite3.connect(data / "docs.db") as db:
                    self.assertEqual(db.execute("SELECT content FROM notes").fetchone()[0], "edited production document")
            else:
                self.assertIn(NEW, os.readlink(web / "current"))
            self.assertEqual(len(list((root / "backups").glob("*/data.tar.gz"))), 1)
            self.assertNotIn("prune", (base / "calls").read_text())

    def test_success(self):
        self.run_deployment("")

    def test_health_failure_restores_database_attachments_and_website(self):
        self.run_deployment("health")

    def test_nginx_failure_restores_database_attachments_and_website(self):
        self.run_deployment("nginx")


if __name__ == "__main__":
    unittest.main()
