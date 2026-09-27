# Local Clipboard 3

Self-hosted локальный веб-буфер, файловый ящик и прямая передача между устройствами для iPhone, Mac, Windows и любого устройства с браузером. Приложение рассчитано на одну локальную сеть, запускается в Docker и не требует расширений браузера или прав администратора на рабочем Windows-компьютере.

## Возможности

- Большое текстовое поле с последней сохраненной записью.
- Кнопки: `Вставить`, `Копировать`, `Сохранить`, `Очистить`, `Редактор`, `Просмотр`.
- История последних записей с открытием, копированием, удалением и полной очисткой.
- WebSocket-синхронизация между открытыми страницами.
- Markdown-просмотр без выполнения пользовательского HTML или JavaScript.
- Вход по паролю для веб-интерфейса и Bearer token для API.
- SQLite в WAL-режиме, автоочистка по количеству, сроку хранения и размеру БД.
- Светлая/темная тема с ручным переключателем.
- Загрузка нескольких файлов, drag-and-drop, прогресс, скачивание и удаление.
- Постоянное хранение файлов в Docker-томе, отдельно от образа приложения.
- Обнаружение открытых устройств в локальной сети.
- Прямая WebRTC-передача нескольких файлов без сохранения на сервере.
- Подтверждение входящей передачи и прогресс в обе стороны.

Markdown реализован локальным JavaScript-парсером в `app/static/app.js`; внешние CDN и vendor-библиотеки не используются.

## Быстрый запуск

```bash
cp .env.example .env
```

Откройте `.env` и замените минимум:

```env
APP_PASSWORD=your-long-password
API_TOKEN=your-long-random-token
SESSION_SECRET=another-long-random-secret
BIND_ADDRESS=0.0.0.0
```

Запуск:

```bash
docker compose up -d --build
```

Откройте:

```text
http://IP_СЕРВЕРА:8080
```

По умолчанию `docker-compose.yml` привязывает порт к `127.0.0.1`. Для доступа из локальной сети задайте `BIND_ADDRESS=0.0.0.0` или конкретный LAN-IP сервера.

## Переменные окружения

| Переменная | Значение по умолчанию |
| --- | --- |
| `APP_HOST` | `0.0.0.0` |
| `APP_PORT` | `8080` |
| `APP_PASSWORD` | `change-me` |
| `API_TOKEN` | `change-me` |
| `SESSION_SECRET` | `change-me` |
| `SESSION_SECURE` | `false` |
| `MAX_ENTRY_BYTES` | `512000` |
| `MAX_HISTORY_ITEMS` | `50` |
| `RETENTION_DAYS` | `30` |
| `MAX_DATABASE_BYTES` | `104857600` |
| `DATABASE_PATH` | `/data/clipboard.db` |
| `FILE_STORAGE_PATH` | `/data/files` |
| `MAX_FILE_BYTES` | `104857600` (100 МБ) |
| `MAX_FILE_STORAGE_BYTES` | `2147483648` (2 ГБ) |
| `TIMEZONE` | `Europe/Amsterdam` |

Если `APP_PASSWORD`, `API_TOKEN` или `SESSION_SECRET` не заданы либо равны `change-me`, приложение откажется запускаться. Для локальной разработки можно временно включить `DEV_MODE=true`.

## API

Загрузить файл:

```bash
curl -X POST "http://SERVER_IP:8080/api/files" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -F "upload=@/path/to/file" \
  -F "source=mac"
```

Получить список файлов:

```bash
curl "http://SERVER_IP:8080/api/files" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Сохранить текст:

```bash
curl -X POST "http://SERVER_IP:8080/api/clipboard" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Пример текста","source":"mac"}'
```

Получить последний текст:

```bash
curl "http://SERVER_IP:8080/api/clipboard" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Endpoint:

- `GET /api/files`
- `POST /api/files`
- `GET /api/files/{id}/download`
- `DELETE /api/files/{id}`
- `GET /api/clipboard`
- `POST /api/clipboard`
- `PUT /api/clipboard/{id}`
- `DELETE /api/clipboard/{id}`
- `GET /api/history`
- `DELETE /api/history`
- `GET /api/health`
- `GET /api/config`
- `WebSocket /ws`

При превышении размера записи или файла сервер возвращает HTTP `413`.

## Apple Shortcuts

Команда `Отправить буфер`:

1. Добавьте действие `Получить буфер обмена`.
2. Добавьте действие `Получить содержимое URL`.
3. URL: `http://SERVER_IP:8080/api/clipboard`.
4. Метод: `POST`.
5. Заголовки:
   - `Authorization`: `Bearer YOUR_API_TOKEN`
   - `Content-Type`: `application/json`
6. Тело запроса JSON:

```json
{
  "text": "Clipboard",
  "source": "iphone-shortcut"
}
```

В поле `text` подставьте переменную из действия `Получить буфер обмена`. После запроса добавьте уведомление об успешной отправке.

Команда `Получить буфер`:

1. Добавьте действие `Получить содержимое URL`.
2. URL: `http://SERVER_IP:8080/api/clipboard`.
3. Метод: `GET`.
4. Заголовок `Authorization`: `Bearer YOUR_API_TOKEN`.
5. Получите поле `text` из JSON.
6. Добавьте действие `Скопировать в буфер обмена`.

## Clipboard API и HTTPS

Кнопка `Копировать` старается использовать Clipboard API и fallback через выделение текста. Кнопка `Вставить` зависит от политики браузера: для локального IP по обычному HTTP браузер может запретить чтение буфера. В таком случае приложение покажет сообщение: `Браузер не разрешил чтение буфера обмена. Используйте Ctrl+V или вставку через контекстное меню`.

Для полной работы Clipboard API лучше настроить локальный HTTPS.

Пример Caddy:

```caddyfile
clipboard.local {
  tls internal
  reverse_proxy 127.0.0.1:8080
}
```

Можно добавить локальное имя `clipboard.local` через DNS роутера, Pi-hole, AdGuard Home или hosts-файлы. mDNS не требуется.

## Proxmox

Подходит для:

- Docker внутри Debian LXC.
- Docker внутри небольшой VM.
- Portainer.
- Обычного Docker Compose.

Привилегированный контейнер не нужен. Минимальные ресурсы:

- 1 vCPU.
- 256-512 MB RAM.
- 1-2 GB диска.

Готовый install-скрипт находится в `scripts/install-proxmox.sh`. Он рассчитан на репозиторий `https://github.com/JuNglEKZN/local-clipboard.git`; при необходимости можно переопределить `REPO_URL`.

Обновление существующей установки до версии 3 сохраняет пароль, историю и Docker-том:

```bash
cd /opt/local-clipboard
git pull
docker compose up -d --build
```

Для файлового хранилища рекомендуется выделить контейнеру не менее 4 ГБ диска.

## Устройства рядом

Откройте вкладку `Рядом` на двух устройствах. Они появятся друг у друга автоматически. Выберите получателя, укажите один или несколько файлов и подтвердите приём на втором устройстве.

Proxmox участвует только в обнаружении устройств и обмене служебными WebRTC-сигналами. Содержимое файлов передаётся напрямую между браузерами и не сохраняется на сервере. Оба устройства должны быть открыты одновременно.

Режим рассчитан на одну локальную сеть и не использует внешние STUN/TURN-серверы. Для наиболее стабильной работы Safari на iOS рекомендуется локальный HTTPS.

За одну прямую передачу можно отправить пакет до 256 МБ. Ограничение защищает мобильные браузеры: принятые данные временно находятся в памяти устройства до нажатия `Сохранить`.

## Разработка

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
DEV_MODE=true APP_PASSWORD=test API_TOKEN=test SESSION_SECRET=test DATABASE_PATH=./data/clipboard.db uvicorn app.main:app --reload --port 8080
```

Тесты:

```bash
pytest
```

## Безопасность

Приложение не отправляет данные наружу, не содержит аналитики и трекеров. Веб-интерфейс использует HTTP-only session cookie и CSRF-защиту для изменяющих запросов. API использует `Authorization: Bearer <token>` с постоянным сравнением токенов. Markdown-просмотр экранирует HTML, запрещает пользовательские обработчики событий и опасные URL.
