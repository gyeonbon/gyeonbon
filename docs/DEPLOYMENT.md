# 실제 웹사이트로 배포하기

이 앱은 정적 화면과 실시간 Node 서버가 함께 동작합니다. 서버는 SSE 연결과 세션 상태를 유지하므로, 단일 인스턴스의 상시 실행 Node 서비스에 배포하세요. 정적 호스팅만 사용하거나 일회성 서버리스 함수로 서버를 대체하면 수업 동기화와 복구를 유지할 수 없습니다.

외부 API 키나 유료 AI 서비스는 필요하지 않습니다. 도메인·호스팅 요금은 선택한 서비스의 정책을 따릅니다.

## 배포 버튼으로 시작하기

[Render에서 이 프로젝트 배포 설정 열기](https://render.com/deploy?repo=https://github.com/gyeonbon/gyeonbon)

GitHub에 소스가 올라간 뒤 위 링크를 열고 Render에 로그인하면, 저장소의 `render.yaml`이 Node 실행 설정을 채웁니다. GitHub 저장소 접근을 허용하고 설정을 확인한 뒤 배포를 실행하세요. 이 링크는 배포 설정 화면이며 게임 사이트 주소는 아닙니다. 실제 주소는 배포가 성공하면 Render가 표시합니다.

Blueprint는 테스트용 무료 서비스 하나를 선언하며 유료 디스크를 생성하지 않습니다. 무료 서비스의 절전·재시작·임시 저장소 특성을 고려해, 실제 수업 전에는 아래 지속 저장소와 운영 안내를 확인하세요. 계정 로그인과 GitHub 접근 승인은 계정 소유자가 직접 수행해야 합니다.

## 방법 A · Render Node 웹 서비스

1. 프로젝트를 GitHub 저장소에 저장하고 Render에서 **New → Web Service**를 선택해 해당 저장소를 연결합니다.
2. Node 환경으로 다음 명령을 설정합니다.

   ```text
   Build Command: npm ci && npm run build
   Start Command: npm start
   Health Check Path: /api/health
   ```

3. 서버 인스턴스 수는 **1개**로 유지합니다. Node 버전은 22 이상을 선택합니다. `PORT`는 Render가 주입하는 값을 그대로 사용합니다.
4. 환경변수 `PUBLIC_ORIGIN`을 실제 사이트 출처로 설정합니다. 예: `https://your-school-game.onrender.com`. 경로·쿼리·끝 슬래시는 넣지 않습니다. 사용자 도메인을 연결한다면 그 도메인을 사용합니다.
5. 재시작 뒤에도 수업을 복구하려면 Persistent Disk를 `/var/data`에 연결하고 `DATA_DIR=/var/data/blind-teaching`을 설정합니다. 디스크를 사용할 수 있는 요금제와 가격은 Render의 현재 안내를 확인하세요.
6. 배포가 끝나면 HTTPS 주소를 열어 교사 세션을 만들고 학생용 QR코드가 **공개 HTTPS 주소**를 가리키는지 확인합니다.

지속 디스크 없이도 서버가 유지되는 동안 수업을 진행할 수 있지만, 재배포·재시작·인스턴스 교체 후 세션 복구를 보장할 수 없습니다. 무료 서비스의 절전·콜드 스타트 조건도 사전에 확인하고, 수업 전에 서버를 열어 두세요. 수업 중에는 재배포하지 마세요.

교사용 접근 정보는 교사가 사용한 브라우저에 보관됩니다. 학생에게는 대시보드에서 제공하는 학생용 링크와 QR코드만 공유하세요. 관리 권한을 가진 접근 정보를 빔프로젝터에 노출하거나 메신저에 공유하지 마세요.

## 방법 B · Docker

Dockerfile은 프론트엔드를 빌드한 뒤 Node 서버·게임 엔진·빌드된 화면만 실행 이미지에 복사합니다.

```sh
docker build -t blind-teaching .
docker volume create blind-teaching-data
docker run -d --name blind-teaching \
  -p 3000:3000 \
  -e PUBLIC_ORIGIN=https://game.example.org \
  -v blind-teaching-data:/app/.data \
  --restart unless-stopped \
  blind-teaching
```

`game.example.org`는 예시입니다. 실제 도메인으로 바꾸고 앞단에 HTTPS 프록시를 설정해야 스마트폰에서 공개 주소로 접속할 수 있습니다. 기본 포트는 3000이며 컨테이너 내부 `/app/.data`가 복구 파일 위치입니다. 호스트 디렉터리를 직접 연결한다면 컨테이너의 `node` 사용자(일반적으로 UID 1000)가 해당 디렉터리에 쓰기 가능한지 확인하세요.

TLS 검사 프록시를 사용하는 개발 환경에서는 해당 환경이 제공한 공개 CA 인증서를 BuildKit secret으로 전달할 수 있습니다. Dockerfile은 `proxy_ca`가 있을 때 npm의 추가 신뢰 인증서로 사용하며 이미지에는 남기지 않습니다. 예: `docker build --secret id=proxy_ca,src=/path/to/proxy-ca.pem -t blind-teaching .`. TLS 검증을 끄는 옵션은 사용하지 않습니다.

실행 확인:

```sh
curl --fail http://127.0.0.1:3000/api/health
docker logs blind-teaching
```

상태 확인 응답의 `ok`가 `true`이고 `recovery`가 `enabled`인지 확인합니다. 로그와 데이터 디렉터리에는 참여 정보가 포함될 수 있으므로 외부에 공개하지 마세요.

## VPS와 Nginx를 사용하는 경우

Node는 로컬 3000번 포트에서 실행하고 Nginx에서 HTTPS를 종료할 수 있습니다. 아래는 **이미 유효한 TLS 인증서가 설치된 서버**의 예시입니다. 인증서는 도메인 소유 확인 뒤 Let's Encrypt 등 지원되는 경로로 발급·갱신하세요.

```nginx
server {
    listen 443 ssl;
    server_name game.example.org;
    # SSE 주소의 인증 쿼리가 접근 로그에 남지 않도록 합니다.
    access_log off;

    ssl_certificate /etc/letsencrypt/live/game.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.example.org/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

HTTP 요청은 HTTPS로 리디렉션하고 `PUBLIC_ORIGIN=https://game.example.org`를 지정합니다. SSE가 지연되지 않게 응답 버퍼링을 끄고, 로드밸런서·CDN의 연결 시간 제한도 확인하세요. 인증 쿼리가 있는 SSE 요청 주소는 접근 로그에 저장하지 않거나 쿼리를 제거해 기록합니다. 외부 프록시·CDN에서도 같은 설정을 확인하세요. 서버 프로세스는 systemd나 컨테이너 재시작 정책으로 유지하며 세션을 여러 프로세스로 분산하지 않습니다.

## 수업 전 확인 · 11월 4일

교사 PC와 학생 스마트폰을 실제 사용할 학교 Wi-Fi에 연결한 상태에서 확인합니다.

- 공개 HTTPS 주소가 학교망에서 열리는지 확인합니다. 차단된다면 학교 네트워크 담당자에게 **배포한 실제 호스트**의 HTTPS 접속 허용을 요청합니다.
- 교사 세션을 만든 뒤 QR코드를 iPhone·Android에서 각각 열고, 별명과 모둠을 선택합니다.
- 교사 기기 1대와 학생 기기 2대 이상으로 선택·그림·질문·정답 제출·갤러리 공개를 끝까지 진행합니다. 학생 측에서 제시어와 그림이 공개 전 보이지 않는지 확인합니다.
- 손가락으로 그릴 때 페이지가 끌려가지 않는지, 한글 입력 중 제출 버튼을 누르기 쉬운지 확인합니다.
- 학생 탭을 새로고침하거나 Wi-Fi를 잠깐 끊었다가 연결해 복구를 확인합니다. 교사의 일시정지·재개도 함께 확인합니다.
- 빔프로젝터에서 발표 화면의 그림과 별명이 읽히는지 확인하고, 결과 PNG 저장을 시험합니다.
- 최종 운영 주소에서 세션을 다시 만들고 실제 참여할 학생 2~30명이 입장한 뒤 모둠별 2~5명으로 배정합니다. 교사 화면에서 모둠 추가·삭제와 자동 편성이 반영되는지 확인합니다. 수업 중 배포나 서버 재시작은 피합니다.

자동화된 테스트의 통과와 실제 학교망·물리적인 스마트폰 검증은 별개입니다. 배포 제공자 계정 연결, 실제 DNS/TLS 설정, 학교 Wi-Fi 허용은 사용자가 사용하는 환경에서 완료해야 합니다.

## 운영·복구

- 교사가 수업을 종료하면 학생의 추가 게임 조작을 막습니다. 필요한 결과 이미지는 종료 전에 저장하세요.
- 세션의 비활성 보존 기한은 6시간입니다. 별명·그림·정답·돌아보기 외의 개인정보 입력은 요구하지 않습니다.
- 복구 파일에는 비공개 제시어와 권한 토큰이 포함되므로, `DATA_DIR`를 웹 루트·공개 버킷·Git 저장소에 놓지 않습니다.
- 활성 세션을 서버 재시작으로 복구하면 일시정지 상태로 시작합니다. 교사가 학생 상태와 남은 시간을 확인한 뒤 재개합니다.
- 수업 데이터를 직접 제거해야 하면 서버를 중지하고 `DATA_DIR`의 복구 파일을 삭제합니다. 결과 PNG를 별도로 저장했다면 그 파일도 관리 대상입니다.
- 복제 서버·자동 다중 인스턴스·서버리스로 확장하려면 공유 데이터 저장소와 이벤트 브로커를 별도로 구현해야 합니다. 현재 구성은 단일 인스턴스를 대상으로 합니다.
