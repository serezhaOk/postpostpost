#!/usr/bin/env bash
# Разворачивает postpostpost на бесплатной машине Google Cloud (e2-micro).
# Запускать в Google Cloud Shell (иконка «>_» в консоли Google Cloud):
#   curl -fsSL https://raw.githubusercontent.com/serezhaOk/postpostpost/main/deploy/gcloud.sh | bash
set -euo pipefail

NAME=postpostpost
REGION=${REGION:-us-central1}   # бесплатная e2-micro есть только в us-west1, us-central1, us-east1
ZONE=${ZONE:-$REGION-a}

project=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$project" ]; then
  echo "Не выбран проект. Выполните: gcloud config set project <ID проекта> — и запустите скрипт снова."
  exit 1
fi
echo "→ Проект: $project, зона: $ZONE"

gcloud services enable compute.googleapis.com --quiet

# Постоянный IP: без него адрес сервера сменится при перезапуске, и вход в соцсети сломается
if ! gcloud compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1; then
  echo "→ Резервирую постоянный IP"
  gcloud compute addresses create "$NAME-ip" --region "$REGION" --quiet
fi
ip=$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)')

if ! gcloud compute firewall-rules describe "$NAME-web" >/dev/null 2>&1; then
  echo "→ Открываю порты 80 и 443"
  gcloud compute firewall-rules create "$NAME-web" --allow tcp:80,tcp:443 --target-tags "$NAME-web" --quiet
fi

if ! gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "→ Создаю машину e2-micro"
  gcloud compute instances create "$NAME" --zone "$ZONE" \
    --machine-type e2-micro \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-standard \
    --address "$ip" --tags "$NAME-web" --quiet
  echo "→ Жду, пока машина загрузится"
  sleep 40
fi

domain="$(echo "$ip" | tr . -).sslip.io"
echo "→ Устанавливаю приложение (несколько минут)"
for attempt in 1 2 3 4 5; do
  if gcloud compute ssh "$NAME" --zone "$ZONE" --quiet --command \
    "curl -fsSL https://raw.githubusercontent.com/serezhaOk/postpostpost/main/deploy/install.sh | sudo DOMAIN=$domain bash"; then
    exit 0
  fi
  echo "SSH ещё не готов, пробую снова через 20 секунд…"
  sleep 20
done
echo "Не удалось подключиться к машине. Запустите скрипт ещё раз — он продолжит с того же места."
exit 1
