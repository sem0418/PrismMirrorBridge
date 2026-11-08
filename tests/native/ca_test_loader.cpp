// GPL-3.0-only. Test-environment CA provisioning for an unmodified Linux Prism.
// It adds only the installation's test root; SSL errors are never ignored.
#include <QCoreApplication>
#include <QSslConfiguration>
#include <QSslCertificate>
#include <QDebug>
static void addTestRoot() {
    const auto path = qEnvironmentVariable("PRISM_BRIDGE_TEST_CA");
    if (path.isEmpty()) return;
    const auto certificates = QSslCertificate::fromPath(path);
    if (certificates.size() != 1 || !certificates.first().subjectInfo(QSslCertificate::CommonName).join("").startsWith("Prism Mirror Bridge "))
        qFatal("Invalid isolated bridge test certificate");
    auto configuration = QSslConfiguration::defaultConfiguration();
    configuration.addCaCertificates(certificates);
    QSslConfiguration::setDefaultConfiguration(configuration);
    qInfo("Provisioned isolated bridge test CA; normal certificate verification stays enabled");
}
Q_COREAPP_STARTUP_FUNCTION(addTestRoot)
