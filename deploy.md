# 部署到 littlerp.zoymonster.com

## 服务器信息
- 阿里云 ECS: `59.110.215.35`
- SSH: `ssh root@59.110.215.35`
- Web 根目录: `/var/www/littlerp/`
- Nginx 配置: `/etc/nginx/conf.d/littlerp.conf`
- SSL: Let's Encrypt (证书路径 /etc/letsencrypt/live/zoymonster.com/)

## 一键部署命令

```bash
# 从本地 littlerp 目录上传（排除不需要的文件，--chmod 保证 nginx 可读）
rsync -avz --delete --chmod=D755,F644 \
  --exclude='.DS_Store' \
  --exclude='按键.txt' \
  --exclude='deploy.md' \
  --exclude='ui赠图' \
  --exclude='插画赠图' \
  --exclude='封面+日程表' \
  --exclude='日常滤镜' \
  --exclude='server' \
  --exclude='训练*' \
  ~/Downloads/littlerp/ root@59.110.215.35:/var/www/littlerp/
```

## 验证
```bash
# 检查站点是否正常
curl -sI https://littlerp.zoymonster.com/

# SSH 到服务器查看文件
ssh root@59.110.215.35 "ls -la /var/www/littlerp/"
```

## Nginx 配置（已在服务器上配好，一般不用改）
- 80 端口自动 301 跳转 HTTPS
- .moc3 文件设为 application/octet-stream
- .json 文件设为 UTF-8 charset

## 注意事项
- `--chmod=D755,F644` 确保目录 755、文件 644 权限，无需再手动 chmod
- `小兔猪/` 目录包含 Live2D 模型文件(.moc3/.model3.json 等)，必须一起上传
- 赠图/滤镜等素材目录已排除，不需要部署到线上
