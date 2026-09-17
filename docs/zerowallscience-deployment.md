# ZeroWall Science 生产维护

## 站点与服务

生产主机为 uscavaslinux（66.154.100.202）。沿用有效证书和 DNS。
zerowallscience.org 为主站；.com 与两个 www 地址保留路径和查询参数 301 到主站。
/zh/ 跳转到中文首页 /，英文入口为 /en/。

文档 Compose 项目位于 /opt/zerowallscience-docs/compose。
后端仅绑定 127.0.0.1:13001，独立默认网络、SQLite、附件与备份。
限制 1 CPU、1536 MB 内存；日志按 10 MB × 3 轮转。
持久数据在 /var/lib/zerowallscience-docs/data，日备份在同级 backups。

## 编辑与发布

后台管理员在“ZeroWall Science 官方文档”下保存的文章会立即公开。
“草稿（不公开）”是独立根目录，不能放到正式目录下。
目录移动、附件、正文搜索与阅读沿用权限校验；匿名访问不能编辑或注册。
设置 → 文档发布可绑定官方文档目录；设置 → 账号安全可修改密码；
设置 → 数据管理 → 系统提供完整备份与恢复。

## 自动部署

私有仓库 ccfwwm/zerowallscience-docs 的 main 推送和手动触发运行 Deploy production。
部署依赖 CI 的前后端构建、文档初始化测试、URL 测试、隔离回滚测试及官网元数据测试。
镜像和官网全部在 Runner 构建，服务器不安装编译依赖。
每六小时重建官网以刷新 Stable 下载信息，静态版本目录带 SHA 和 UTC 时间，
同一提交的定时部署也不会覆盖正在服务的目录。

GitHub Secrets 中使用本站部署私钥 DEPLOY_KEY 和固定主机指纹 DEPLOY_HOST_KEY。
部署用户为 zerowall-deploy，sudo 仅允许调用 root 持有的
/usr/local/sbin/deploy-zerowallscience-docs。
更新 deploy/deploy.sh 时，管理员需核对脚本后安装到上述固定路径；
工作流只能调用已安装的脚本，不能自行覆盖 root 部署程序。
旧 ccfwwm/zerowallscience-web 的 Deploy 工作流保持 disabled_manually。

## 备份和失败回滚

后台自动完整备份每日 03:00（Asia/Shanghai）运行，保留七份。
部署前的完整停写备份独立存放在 /opt/zerowallscience-docs/backups/<SHA-时间>/，
不受日备份保留策略影响。含站点配置、旧官网归档、旧 Compose 与 data.tar.gz。
生产 .env 由服务器单独保管，不写入 Actions 日志或仓库。

每次替换镜像前创建本站 maintenance 标记并停止文档容器，使 SQLite 与附件一致。
仅本站临时返回 503。新容器 healthy、API 和文档直达检查通过、nginx -t 通过后，
原子切换 current 链接并平滑 reload；最后解除维护。
失败时保持维护，恢复此次停写快照、旧 Compose、旧镜像和官网，
健康检查通过后解除维护。失败数据库留在该部署备份目录的 failed-data 供排查。
恢复失败则保留 maintenance，防止错误数据继续写入。

已成功上线后，不得直接使用旧数据快照覆盖后台新增编辑。
需要回退时应重新进入维护、保存当前完整数据，再选择对应备份恢复。
本地备份没有异地容灾保证。

本站仅保留最近三套官网版本、上传产物及对应镜像，不执行 Docker 全局清理。
隔离回滚测试通过临时 SQLite、附件和替代服务命令验证健康失败与 Nginx 配置失败的恢复路径：
python3 scripts/tests/zerowall-deploy.test.py（Linux 环境）。
