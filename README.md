# 🛠️ DiscordBotEkipaRemontowa

Bot Discord dedykowany dla serwera **Ekipa Remontowa**, służący do monitorowania aktywności na kanałach głosowych użytkowników oraz automatycznego usuwania wiadomości z wybranego kanału po określonym czasie.

## 🚀 Główne Funkcje

1. **Monitorowanie Czasu Głosowego**: Automatycznie zlicza czas spędzony przez użytkowników na kanałach głosowych z dokładnym podziałem dziennym, tygodniowym i miesięcznym.
2. **Profile, Rankingi i Statystyki**: 
   - `/profile [uzytkownik]` – szczegółowy, estetyczny profil aktywności głosowej (dzisiaj, tydzień, miesiąc, łącznie, pozycje w rankingu oraz status na kanale na żywo).
   - `/daily [uzytkownik]` – czas spędzony na rozmowach dzisiaj oraz pozycja w rankingu dnia.
   - `/weekly [uzytkownik]` – czas spędzony w bieżącym tygodniu (od poniedziałku) oraz pozycja w rankingu tygodniowym.
   - `/monthly [uzytkownik]` – czas spędzony w bieżącym miesiącu oraz pozycja w rankingu miesięcznym.
   - `/time [uzytkownik] [okres]` – szybkie sprawdzenie czasu dla wybranego okresu lub łącznie.
   - `/leaderboard [okres] [strona]` – interaktywny ranking TOP użytkowników z podziałem na strony (przyciski `◀ Poprzednia` / `Następna ▶`) oraz filtrowaniem okresów (`łącznie`, `dzisiaj`, `tydzień`, `miesiąc`).
3. **Automatyczne Czyszczenie Kanału**: Co określony czas usuwa wiadomości starsze niż zadany limit na wskazanym kanale.
4. **Komendy Moderacyjne**:
   - `/clear <ilość>` – natychmiastowe czyszczenie wiadomości (również starszych niż 14 dni).
   - `/stop` – zatrzymanie powolnego usuwania starych wiadomości.
   - `/autoclean <status>` – włączanie/wyłączanie automatycznego czyszczenia.
5. **Działa 24/7 na Render**: Wbudowany serwer Express.js odpowiada na pingi zewnętrzne, dzięki czemu bot nie przechodzi w stan uśpienia.
6. **Baza Danych PostgreSQL (Supabase) + SQLite**: Pełna trwałość danych bez ryzyka utraty godzin po restarcie.

---

## ⚙️ KROK 1: Przygotowanie Bota w Discord Developer Portal

Zanim uruchomisz bota, musisz zarejestrować aplikację w Discordzie:

1. Przejdź do [Discord Developer Portal](https://discord.com/developers/applications).
2. Kliknij **New Application** i nazwij swojego bota (np. `Ekipa Remontowa Bot`).
3. Przejdź do zakładki **Bot** po lewej stronie:
   - Kliknij **Reset Token** i skopiuj wygenerowany token (będzie potrzebny jako `DISCORD_TOKEN`).
   - W sekcji **Privileged Gateway Intents** zaznacz/włącz:
     - **Presence Intent**
     - **Server Members Intent**
     - **Message Content Intent** (kluczowe do odczytywania wiadomości przy czyszczeniu)
   - Zapisz zmiany klikając **Save Changes**.
4. Przejdź do zakładki **OAuth2** -> **General**:
   - Skopiuj **Client ID** (będzie potrzebny jako `CLIENT_ID`).
5. Przejdź do zakładki **OAuth2** -> **URL Generator**:
   - W sekcji **Scopes** zaznacz: `bot` oraz `applications.commands`.
   - W sekcji **Bot Permissions** zaznacz:
     - `Manage Messages` (do usuwania wiadomości)
     - `Read Message History`
     - `Send Messages`
     - `View Channel`
     - `Connect` / `Speak` (do nasłuchiwania obecności na kanałach głosowych)
   - Skopiuj wygenerowany link na samym dole i wklej go do przeglądarki, aby zaprosić bota na swój serwer.

---

## 💻 KROK 2: Konfiguracja Lokalna (Przed wdrożeniem)

1. Sklonuj swoje repozytorium na komputerze:
   ```bash
   git clone https://github.com/MrP3rru/DiscordBotEkipaRemontowa.git
   cd DiscordBotEkipaRemontowa
   ```
2. Skopiuj plik `.env.example` i nazwij go `.env`:
   - Wpisz w nim swój `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` (ID Twojego serwera Discord) oraz `CLEAN_CHANNEL_ID` (ID kanału, który ma być czyszczony).
3. Zainstaluj zależności:
   ```bash
   npm install
   ```
4. Uruchom bota lokalnie do testów:
   ```bash
   npm start
   ```

*(Aby uzyskać ID serwera lub kanału: włącz w Discordzie Ustawienia -> Zaawansowane -> Tryb Dewelopera, a następnie kliknij prawym przyciskiem myszy na serwer/kanał i wybierz "Kopiuj ID")*

---

## 🌐 KROK 3: Wdrożenie na Render.com

Darmowe aplikacje Web Service na Render zasypiają po 15 minutach bezczynności HTTP. Aby temu zapobiec, nasz bot posiada wbudowany serwer WWW.

### Konfiguracja na Render.com:
1. Zaloguj się na [Render.com](https://dashboard.render.com).
2. Kliknij przycisk **New +** i wybierz **Web Service**.
3. Połącz swoje konto GitHub i wybierz repozytorium `DiscordBotEkipaRemontowa`.
4. Skonfiguruj usługę:
   - **Name**: `discord-bot-ekipa` (lub dowolna nazwa)
   - **Language**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. Rozwiń sekcję **Advanced** i dodaj następujące zmienne środowiskowe (**Environment Variables**):
   - `DISCORD_TOKEN` = *(Twój token bota)*
   - `CLIENT_ID` = *(Twój client id)*
   - `GUILD_ID` = *(ID serwera Discord)*
   - `CLEAN_CHANNEL_ID` = *(ID kanału do czyszczenia)*
   - `MESSAGE_LIFETIME_MINUTES` = `60` (lub inny czas w minutach)
   - `CLEAN_INTERVAL_MINUTES` = `5` (częstotliwość sprawdzania)
   - `PORT` = `3000`
6. Kliknij **Create Web Service**. Render zbuduje i uruchomi Twojego bota! Na górze panelu Render zobaczysz adres URL bota (np. `https://discord-bot-ekipa.onrender.com`). Skopiuj go.

---

## ⏰ KROK 4: Utrzymanie bota przy życiu 24/7 (Obejście uśpienia Render)

Darmowy serwer Render wyłącza się, jeśli nikt na niego nie wchodzi. Aby bot działał bez przerw, musimy go stale "pingować":

1. Zarejestruj się na darmowej stronie [UptimeRobot](https://uptimerobot.com) lub [Cron-Job.org](https://cron-job.org).
2. Kliknij **Add New Monitor**.
3. Wybierz typ monitora: **HTTP(s)**.
4. Nazwij go np. `Ekipa Bot Ping`.
5. Wklej URL swojej aplikacji z Render.com (np. `https://discord-bot-ekipa.onrender.com/`).
6. Ustaw interwał (Monitoring Interval) na co **5 minut** lub **10 minut**.
7. Zapisz monitor.

**Jak to działa?** UptimeRobot będzie wysyłał zapytanie HTTP na Twój serwer co 5 minut. Render uzna to za aktywność i **nigdy nie wyłączy (nie uśpi) bota**.

---

## 💾 KROK 5: Trwały zapis danych z Supabase (Unikanie resetu czasu na Render)

Darmowy serwer Render ma **ulotny dysk (ephemeral storage)**. Oznacza to, że lokalna baza SQLite (`database.sqlite`) resetuje się przy każdym restarcie serwera (np. po dodaniu nowego kodu lub raz na dobę). Aby temu zapobiec, zintegrowaliśmy bota z bazą PostgreSQL z **Supabase**, którą właśnie założyłeś!

### Jak połączyć bazę Supabase z botem:

1. Zaloguj się do swojego panelu [Supabase](https://supabase.com/).
2. Wejdź w projekt **Bot_Discord_SUPRABASE**.
3. W lewym dolnym rogu kliknij ikonkę zębatki (**Project Settings**), a następnie zakładkę **Database**.
4. Przewiń w dół do sekcji **Connection string** i wybierz zakładkę **URI** (lub Node.js).
5. Skopiuj wygenerowany adres. Będzie on wyglądał mniej więcej tak:
   `postgresql://postgres.[PROJEKT_ID]:[HASLO]@aws-0-[REGION].pooler.supabase.com:6543/postgres`
   *lub (starszy format):*
   `postgresql://postgres:[HASLO]@db.[PROJEKT_ID].supabase.co:5432/postgres`
6. Zastąp element `[HASLO]` swoim hasłem do bazy, które mi podałeś: `ukaq15M1cury5h9r` (pamiętaj, aby usunąć nawiasy kwadratowe!).
7. **Lokalnie**: Wklej ten pełny link w pliku `.env` jako wartość `DATABASE_URL`.
8. **Na Render.com**: W panelu sterowania swojej usługi Render wejdź w zakładkę **Environment** i dodaj nową zmienną:
   - Klucz: `DATABASE_URL`
   - Wartość: *(Twój pełny link z hasłem z kroku 6)*
9. Zapisz zmiany na Render.

### Jak to działa?
Bot automatycznie wykryje zmienną `DATABASE_URL`. Jeśli jest obecna, bot będzie zapisywał czas na zewnętrznej bazie Supabase (dane będą bezpieczne i nigdy się nie skasują). Jeśli jej nie ma, bot automatycznie przełączy się na lokalny plik SQLite (przydatne do szybkich testów lokalnych na komputerze).
