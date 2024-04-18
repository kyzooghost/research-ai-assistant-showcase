FROM amazonlinux:2023

USER root
WORKDIR /home

COPY . .

RUN yum update -y
RUN yum install python3-pip -y
RUN pip3 install -r requirements.txt