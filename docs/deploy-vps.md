# Развёртывание NARD на VPS

Приложению нужен один процесс Node.js 22.12 или новее и HTTPS-прокси перед ним. Ниже пример для Linux, systemd и Caddy. Домен `nard.example.com`, путь `/opt/nard` и имя системного пользователя `nard` замените на свои значения. Команды развёртывания выполняет владелец VPS; проект сам ничего не публикует.

## 1. Подготовить код и постоянные каталоги

Настройте DNS-домен на адрес VPS и разрешите входящие подключения к портам 80 и 443. Node-сервер слушает только `127.0.0.1:4173`, поэтому не открывайте порт 4173 наружу. В примере предполагается, что выполняющий команды пользователь может записывать в `/opt`; если это не так, заранее создайте каталог с нужным владельцем.

```bash
git clone https://github.com/liquidsyntes/gm_nard.git /opt/nard
cd /opt/nard
npm ci
npm run build
sudo useradd --system --home-dir /var/lib/nard --shell /usr/sbin/nologin nard
sudo install -d -m 700 -o nard -g nard /var/lib/nard /var/log/nard
```

Если системный пользователь уже создан, пропустите команду `useradd`. Код и `node_modules` должны быть доступны ему на чтение. Каталог `/var/lib/nard` хранит `state.json` с аккаунтами, сессиями, приглашениями и партиями. JSONL-журналы находятся в `/var/log/nard`. Не включайте эти каталоги в Git и не удаляйте их при обновлении кода.

## 2. Создать администратора

Сервер должен быть остановлен, пока вы выполняете CLI-команды управления администратором. Создайте первого администратора от имени системного пользователя службы:

```bash
cd /opt/nard
sudo -u nard env GAME_DATA_DIR=/var/lib/nard node server/admin-cli.mjs create Admin
```

Команда выведет личный токен один раз. Сохраните его вне репозитория и не передавайте через URL или публичные сообщения. Затем войдите по токену на `/online.html`. В админ-панели создавайте игроков, перевыпускайте их токены и отключайте аккаунты. Токены игроков также показываются только при создании или перевыпуске. Самостоятельной регистрации нет.

Если токен администратора утрачен, остановите службу, выполните `sudo -u nard env GAME_DATA_DIR=/var/lib/nard node server/admin-cli.mjs rotate Admin` и снова запустите службу. Перевыпуск завершает старые сессии администратора. Не запускайте CLI одновременно с сервером: приложение рассчитано на один процесс, который меняет файл состояния.

## 3. Запустить Node через systemd

Возьмите [пример службы](../deploy/nard.service.example), замените `nard.example.com`, `/opt/nard` и путь к исполняемому файлу `node` на фактические значения. `PUBLIC_ORIGIN` должен совпадать с внешним HTTPS-адресом сайта без пути. В режиме `NODE_ENV=production` запуск без `PUBLIC_ORIGIN` запрещён.

```bash
sudo cp deploy/nard.service.example /etc/systemd/system/nard.service
sudoedit /etc/systemd/system/nard.service
sudo systemctl daemon-reload
sudo systemctl enable --now nard
curl -f http://127.0.0.1:4173/api/health
```

Ответ healthcheck: `{"ok":true}`. Для диагностики запуска используйте `sudo journalctl -u nard -n 100 --no-pager`. Если Node установлен не в `/usr/bin/node`, укажите в службе путь из `command -v node`.

## 4. Включить HTTPS-прокси

Добавьте [пример блока Caddy](../deploy/Caddyfile.example) в собственный Caddyfile, заменив домен. Caddy проксирует запросы к локальному Node-процессу. Ответы Server-Sent Events имеют тип `text/event-stream`; Caddy отправляет их без ожидания заполнения буфера. При корректном DNS и доступных портах 80/443 Caddy может автоматически выпустить и обновлять сертификат. Подробности: [автоматический HTTPS](https://caddyserver.com/docs/automatic-https) и [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Проверьте страницу `https://nard.example.com/online.html` и вход администратора. После создания двух игроков откройте сайт в двух разных браузерах или профилях: оба должны увидеть друг друга в сети, а приглашение должно открывать общую партию. Для сессии используется cookie `HttpOnly`, `SameSite=Strict`, `Secure` при HTTPS. Токен входа не хранится в браузерном `localStorage` и не включается в адрес страницы.

## Обновление и резервное копирование

Перед обновлением сохраните резервную копию `/var/lib/nard/state.json` и каталог `/var/log/nard`. Файл состояния содержит хэши токенов и сессий, поэтому защищайте копию как закрытые данные.

```bash
sudo systemctl stop nard
cd /opt/nard
git pull --ff-only
npm ci
npm run build
sudo systemctl start nard
curl -f http://127.0.0.1:4173/api/health
```

Один каталог данных должен обслуживать только один процесс NARD. Несколько экземпляров за балансировщиком и общая запись в `state.json` не поддерживаются. Онлайн-партии сохраняются между перезапусками; признак «в сети» зависит от открытого подключения браузера и после перезапуска появляется снова при переподключении клиентов.
