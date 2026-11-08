// GPL-3.0-only. Diagnostic harness for unmodified upstream Prism parser files.
// This is a test executable, not a modified launcher or an authentication shim.
#include <QCoreApplication>
#include <QDirIterator>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTextStream>
#include <QNetworkAccessManager>
#include <QNetworkProxy>
#include <QNetworkReply>
#include <QSslConfiguration>
#include <QSslCertificate>
#include <QEventLoop>
#include <QTimer>
#include "BuildConfig.h"
#include "Json.h"
#include "minecraft/OneSixVersionFormat.h"
#include "minecraft/VersionFile.h"

// Parser diagnostics only use the display name in an optional warning. The
// production launcher's generated build configuration isn't needed here.
Config::Config() { LAUNCHER_DISPLAYNAME = "Prism native parser test"; }
const Config BuildConfig;

static int failures = 0;
static void emitResult(QJsonObject value) {
    if (!value.value("passed").toBool()) failures++;
    QTextStream(stdout) << QJsonDocument(value).toJson(QJsonDocument::Compact) << Qt::endl;
}

static void parseFiles(QString directory) {
    QDirIterator it(directory, { "*.json" }, QDir::Files, QDirIterator::Subdirectories);
    while (it.hasNext()) {
        const QString file = it.next(); QFile input(file);
        if (!input.open(QIODevice::ReadOnly)) continue;
        const auto document = Json::requireDocument(input.readAll(), file);
        if (!document) { emitResult({{"file", QFileInfo(file).fileName()}, {"passed", false}, {"error", document.error()}}); continue; }
        const auto obj = document->object();
        if (!obj.contains("uid") || !obj.contains("version")) continue;
        const auto parsed = OneSixVersionFormat::versionFileFromJson(*document, file, obj.contains("order"));
        if (!parsed) { emitResult({{"file", QFileInfo(file).fileName()}, {"passed", false}, {"error", parsed.error()}}); continue; }
        const auto p = parsed.value(); QJsonArray problems;
        for (const auto& problem : p->getProblems()) problems.append(problem.m_description);
        const bool valid = p->getProblemSeverity() != ProblemSeverity::Error && p->uid == obj["uid"].toString() && p->version == obj["version"].toString();
        QJsonObject platforms;
        const QList<QPair<QString,QString>> runtimes = {{"windows", "amd64"}, {"windows", "aarch64"}, {"linux", "amd64"}, {"osx", "amd64"}, {"osx", "aarch64"}};
        for (const auto& [system, architecture] : runtimes) {
            RuntimeContext context; context.system = system; context.javaRealArchitecture = architecture; context.javaArchitecture = "64";
            QJsonArray active;
            for (const auto& library : p->libraries) if (library->isActive(context)) active.append(library->rawName().serialize());
            platforms[system + "-" + architecture] = active;
        }
        emitResult({{"file", QFileInfo(file).fileName()}, {"uid", p->uid}, {"version", p->version}, {"passed", valid},
                    {"mainClass", p->mainClass}, {"libraries", p->libraries.size()}, {"mavenFiles", p->mavenFiles.size()},
                    {"problems", problems}, {"activeLibraries", platforms}});
    }
}

static void network(QString proxyPort, QString caPath) {
    QNetworkAccessManager manager;
    manager.setProxy(QNetworkProxy(QNetworkProxy::HttpProxy, "127.0.0.1", proxyPort.toUShort()));
    auto ssl = QSslConfiguration::defaultConfiguration(); ssl.addCaCertificates(caPath);
    struct Case { QString name; QUrl url; QByteArray body; bool publicCertificate = false; };
    QList<Case> cases = {
        {"qt-loopback-metadata", QUrl("http://127.0.0.1:"+proxyPort+"/meta/v1/net.minecraft/index.json"), {}},
        {"qt-modrinth-search", QUrl("https://api.modrinth.com/v2/search?query=sodium&limit=1"), {}},
        {"qt-curseforge-string-ids", QUrl("https://api.curseforge.com/v1/mods"), "{\"modIds\":[\"238222\"]}"},
        {"qt-microsoft-certificate-tunnel", QUrl("https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration"), {}, true},
    };
    for (const auto& c : cases) {
        QNetworkRequest request(c.url); request.setSslConfiguration(ssl);
        request.setHeader(QNetworkRequest::UserAgentHeader, "PrismNativeCompatibilityTest/1.0");
        request.setTransferTimeout(60000);
        if (!c.body.isEmpty()) request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        QNetworkReply* reply = c.body.isEmpty() ? manager.get(request) : manager.post(request, c.body);
        QEventLoop loop; QTimer timer; timer.setSingleShot(true);
        QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
        QObject::connect(&timer, &QTimer::timeout, reply, &QNetworkReply::abort);
        timer.start(65000); loop.exec(); timer.stop();
        const auto bytes = reply->readAll(); const auto document = QJsonDocument::fromJson(bytes);
        const QString issuer = reply->sslConfiguration().peerCertificate().issuerInfo(QSslCertificate::CommonName).join(", ");
        bool ok = reply->error() == QNetworkReply::NoError && reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 200 && !document.isNull();
        if (c.publicCertificate) ok = ok && !issuer.contains("Prism Mirror Bridge");
        emitResult({{"name", c.name}, {"passed", ok}, {"status", reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()},
                    {"qtNetworkError", int(reply->error())}, {"error", reply->errorString()}, {"certificateIssuer", issuer}, {"bytes", bytes.size()}});
        delete reply;
    }
}

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv); const auto args = app.arguments();
    if (args.size() == 4 && args[1] == "--network") network(args[2], args[3]);
    else if (args.size() == 2) parseFiles(args[1]);
    else return 2;
    return failures ? 1 : 0;
}
