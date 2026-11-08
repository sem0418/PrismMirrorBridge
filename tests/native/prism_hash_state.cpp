// SPDX-License-Identifier: GPL-3.0-only
/* Copyright 2015-2021 MultiMC Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Diagnostic scaffolding only. The following merge function bodies are extracted
// verbatim from Prism 11.1.1; ChecksumValidator.h is included unmodified.
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDebug>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <memory>
#include <set>
#include <iostream>
#include "net/ChecksumValidator.h"
namespace Meta {
struct Require {QString uid; bool operator==(const Require& b)const{return uid==b.uid;}bool operator<(const Require& b)const{return uid<b.uid;}};
using RequireSet=std::set<Require>;
struct Version {
 using Ptr=std::shared_ptr<Version>;
 bool m_providesRecommendations=false,m_recommended=false,m_volatile=false;
 QString m_type,m_sha256; qint64 m_time=0; RequireSet m_requires,m_conflicts;
 void setRecommended(bool x){m_recommended=x;}void setType(const QString& x){m_type=x;}void setTime(qint64 x){m_time=x;}void setVolatile(bool x){m_volatile=x;}
 void mergeFromList(const Ptr&);
};
struct VersionList {
 using Ptr=std::shared_ptr<VersionList>;QString m_name,m_sha256;
 void setName(const QString& x){m_name=x;}void mergeFromIndex(const Ptr&);
};
}

void Meta::Version::mergeFromList(const Meta::Version::Ptr& other)
{
    if (other->m_providesRecommendations) {
        if (m_recommended != other->m_recommended) {
            setRecommended(other->m_recommended);
        }
    }
    if (m_type != other->m_type) {
        setType(other->m_type);
    }
    if (m_time != other->m_time) {
        setTime(other->m_time);
    }
    if (m_requires != other->m_requires) {
        m_requires = other->m_requires;
    }
    if (m_conflicts != other->m_conflicts) {
        m_conflicts = other->m_conflicts;
    }
    if (m_volatile != other->m_volatile) {
        setVolatile(other->m_volatile);
    }
    if (!other->m_sha256.isEmpty()) {
        m_sha256 = other->m_sha256;
    }
}
namespace Meta {
void VersionList::mergeFromIndex(const VersionList::Ptr& other)
{
    if (m_name != other->m_name) {
        setName(other->m_name);
    }
    if (!other->m_sha256.isEmpty()) {
        m_sha256 = other->m_sha256;
    }
}
}

struct Reply:QNetworkReply {
 Reply(){setUrl(QUrl("http://127.0.0.1:17643/meta/v1/net.neoforged/21.1.265.json"));setAttribute(QNetworkRequest::HttpStatusCodeAttribute,200);}
 void abort()override{} qint64 readData(char*,qint64)override{return -1;}
};
QByteArray readFile(const QString& path){QFile f(path);if(!f.open(QIODevice::ReadOnly))qFatal("Missing input");return f.readAll();}
bool valid(QByteArray bytes,const QString& expected){
 Net::ChecksumValidator v(QCryptographicHash::Sha256,expected);QNetworkRequest req;Reply reply;v.init(req);v.write(bytes);return v.validate(reply);
}
int main(int argc,char**argv){
 QCoreApplication app(argc,argv);const QString path=app.arguments().at(1);
 const auto official=readFile(path+"/official-neoforge-component.json"),converted=readFile(path+"/bridge-neoforge-component.json");
 const auto expected=QString::fromLatin1(QCryptographicHash::hash(official,QCryptographicHash::Sha256).toHex());
 const auto actual=QString::fromLatin1(QCryptographicHash::hash(converted,QCryptographicHash::Sha256).toHex());
 const auto index=QJsonDocument::fromJson(readFile(path+"/official-neoforge-index.json")).object();
 const auto bridgeIndex=QJsonDocument::fromJson(readFile(path+"/bridge-neoforge-index.json")).object();
 auto row=[](QJsonObject root){for(auto x:root["versions"].toArray()){auto o=x.toObject();if(o["version"]=="21.1.265")return o;}return QJsonObject();};
 const auto officialRow=row(index),bridgeRow=row(bridgeIndex);
 auto glue=[](QJsonObject r){auto v=std::make_shared<Meta::Version>();v->m_type=r["type"].toString();v->m_sha256=r["sha256"].toString();return v;};
 int failures=0;QJsonArray tests;
 auto check=[&](QString name,bool passed,QJsonObject details=QJsonObject()){
  if(!passed)failures++;details["name"]=name;details["passed"]=passed;tests.append(details);
 };
 check("official bytes match exact user expected hash",expected=="63d850bb1b842adbccb4753027587b5778215c0ed305bdaca080f52e8799021f" && officialRow["sha256"]==expected && valid(official,expected));
 check("bridge bytes match exact user actual hash",converted.size()==36042 && actual=="b7542fda4c29695219c27cac053947ea85a691044d0fb17690889540e7dd3ce1");
 check("unmodified Prism validator rejects bridge bytes with official hash",!valid(converted,expected));
 auto cold=std::make_shared<Meta::Version>();cold->mergeFromList(glue(bridgeRow));
 check("fresh version with hashless bridge row has no checksum expectation",cold->m_sha256.isEmpty() && valid(converted,cold->m_sha256));
 auto warm=glue(officialRow);warm->mergeFromList(glue(bridgeRow));
 check("hashless bridge row preserves official hash in existing version",warm->m_sha256==expected && !valid(converted,warm->m_sha256),{{"retained",warm->m_sha256}});
 check("current disk index is hashless while prior official checksum remains active", !readFile(path+"/bridge-neoforge-index.json").contains("sha256") && warm->m_sha256==expected && !valid(converted,warm->m_sha256));
 auto emptyRow=bridgeRow;emptyRow["sha256"]="";warm->mergeFromList(glue(emptyRow));
 check("explicit empty string also does not clear old hash",warm->m_sha256==expected);
 int rejected=0;for(int i=0;i<3;i++)if(!valid(converted,warm->m_sha256))rejected++;
 check("three validator resets still reject unchanged converted bytes",rejected==3);
 auto correctedRow=bridgeRow;correctedRow["sha256"]=actual;warm->mergeFromList(glue(correctedRow));
 check("nonempty converted hash replaces old hash and validates bytes",warm->m_sha256==actual && valid(converted,warm->m_sha256));
 auto tampered=converted;tampered.append(' ');
 check("corrected expectation still rejects modified bytes",!valid(tampered,warm->m_sha256));
 auto oldList=std::make_shared<Meta::VersionList>();oldList->m_sha256=QString::fromLatin1(QCryptographicHash::hash(readFile(path+"/official-neoforge-index.json"),QCryptographicHash::Sha256).toHex());auto newList=std::make_shared<Meta::VersionList>();oldList->mergeFromIndex(newList);
 check("hashless root entry also preserves old package-index hash",!oldList->m_sha256.isEmpty());
 QJsonObject report{{"passed",failures==0},{"tests",tests},{"scope","Linux C++ probe: exact extracted Prism 11.1.1 merge function bodies + unmodified ChecksumValidator header; minimal surrounding scaffolding; not a complete launcher run"},{"windowsAndPrismRealMachine",QString::fromUtf8("未实机验证")}};
 std::cout<<QJsonDocument(report).toJson().toStdString();return failures?1:0;
}
