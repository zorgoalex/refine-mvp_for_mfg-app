# Контакты поставщиков, производителей и клиентов; связь поставщика с контрагентом 1С

## Контакты

У поставщика и производителя — блок «Контакты»: телефоны, email, аккаунты Telegram; у каждого вида один
«основной» (первый контакт вида становится основным сам). У клиента телефоны остаются в списке телефонов клиента
(`client_phones`, прежние правила), а блок контактов хранит email и Telegram.

| Владелец | Таблица | Виды | Чтение | Изменение |
|---|---|---|---|---|
| Поставщик | `supplier_contacts` | phone, email, telegram | `suppliers.view` | `suppliers.manage` |
| Производитель | `vendor_contacts` | phone, email, telegram | `vendors.view` | `vendors.manage` |
| Клиент | `client_contacts` | email, telegram | `clients.view` | `clients.update` |

- `GET /api/v1/{suppliers|vendors|clients}/:id/contacts` — набор и его версия.
- `PUT …/contacts {version, contacts[]}` — замена набора целиком: версия сравнивается под блокировкой строки
  владельца (`FOR NO KEY UPDATE`), контакт с `contactId` сохраняет id, отсутствующие удаляются. Конфликт версии —
  `409 PARTY_CONTACTS_VERSION_CONFLICT`; неверное значение или вид — `422 PARTY_CONTACT_INVALID`; повтор —
  `422 PARTY_CONTACT_DUPLICATE`.
- `GET /api/v1/supplier-contacts?ids=`, `GET /api/v1/vendor-contacts?ids=` — контакты для колонки списка.
- Версия набора лежит в `party_contact_versions` (нет строки = 0). Строка владельца командой **не обновляется**:
  не меняются `updated_at`/`edited_by`, у клиента не срабатывает CRM-синхронизация.
- Нормализация: телефон → `7XXXXXXXXXX`, email → нижний регистр, Telegram → без `@`.
- Аудит: `supplier.contacts.updated`, `vendor.contacts.updated`, `client.contacts.updated` — только маски
  значений, примечание длиной, связь с владельцем.
- Владельца с контактами нельзя удалить напрямую (`ON DELETE RESTRICT`) — его деактивируют.
- Миграция **236** переносит прежнее поле «Телефон» поставщика в основной телефон набора, если оно читается как
  номер; само поле остаётся в таблице и видно в «Просмотре» как «Телефон (прежнее поле)».

## Связь поставщика с контрагентом 1С

`suppliers.ref_key_1c` меняется только командами backend (в правах Hasura колонка исключена из insert и update):

- `GET /api/v1/supplier-counterparties?search=` — контрагенты для выбора: зеркало 1С (не папки, не помеченные на
  удаление, присутствующие в источнике; поставщики первыми), иначе контрагенты из документов снабжения, иначе
  пусто. У каждого — уже связанный поставщик, если есть.
- `GET /api/v1/suppliers/:id/counterparty` — текущая связь.
- `PUT /api/v1/suppliers/:id/counterparty {refKey1c|null, expectedRefKey1c|null}` — привязать, сменить, снять.
  Текущий ключ сравнивается с `expectedRefKey1c` под блокировкой: расхождение — `409
  SUPPLIER_COUNTERPARTY_CONFLICT` (в `details.refKey1c` — текущее значение); ключ уже равен новому — повтор без
  второго аудита. Контрагент другого поставщика — `409 SUPPLIER_COUNTERPARTY_TAKEN`; неизвестный ключ — `422
  SUPPLIER_COUNTERPARTY_UNKNOWN`. Аудит `supplier.counterparty_linked|unlinked`.
- `POST /api/v1/suppliers/from-counterparty {refKey1c}` — добавить контрагента в справочник (имя контрагента +
  ключ); идемпотентно по ключу. Поставщик с таким названием уже есть — `409 SUPPLIER_NAME_TAKEN`
  (`details.supplierId`): его привязывают командой выше. Аудит `supplier.created_from_counterparty`.

**Эффект привязки:** загрузчик документов 1С на ближайшем проходе проставит `supplier_id` всем документам
контрагента — разовая волна новых ревизий документов; то же при смене и снятии ключа. Ключи заявок и документов
снабжения (`c:<ключ>`) и `resource_suppliers` не меняются.

## Выкладка и откат

Порядок: backend → frontend → metadata Hasura (`ops/apply-hasura-metadata.sh`). Миграция 236 только создаёт
таблицы (таблицы владельцев не меняются) и идёт при работающем backend. Со старым backend блоки контактов и
связи скрыты. Откат: вернуть прежний metadata-файл Hasura и backend; таблицы остаются.
